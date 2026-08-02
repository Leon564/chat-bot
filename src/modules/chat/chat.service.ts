import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { MemoryService } from '../../common/utils/memory.service';
import { LoggingService } from '../../common/utils/logging.service';
import { ContextService } from './context.service';
import { UsageService } from './usage.service';
import { LlmKind } from '../../common/schemas/llm-usage.schema';
import { PromptBuilderService, ALL_BLOCKS } from './prompt-builder.service';
import { IntentRouterService } from './intent-router.service';
import { GraphContextService } from '../graph/graph-context.service';

export type BotPersonality = 'default' | 'unfiltered';

@Injectable()
export class ChatService {
  private openai: OpenAI;
  private readonly logger = new Logger(ChatService.name);

  /**
   * Runtime override for the bot personality. Lives in memory only — on
   * process restart it resets and the value from BOT_PERSONALITY (.env) takes
   * over again. Set via the !personality admin command in chat.
   */
  private personalityOverride: BotPersonality | null = null;

  /**
   * Asegura un único warn por proceso cuando el proveedor detrás de
   * OPENAI_BASE_URL omite `usage` en la respuesta — sin este flag, cada
   * llamada al modelo inundaría el log con el mismo aviso.
   */
  private usageMissingWarned = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly memoryService: MemoryService,
    private readonly loggingService: LoggingService,
    private readonly contextService: ContextService,
    private readonly usageService: UsageService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly intentRouter: IntentRouterService,
    private readonly graphContext: GraphContextService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('openai.apiKey'),
      baseURL: this.configService.get<string>('openai.baseURL') || 'https://api.openai.com/v1',
    });
  }

  async chat(message: string, botName?: string, username?: string): Promise<string> {
    const useMemory = this.configService.get<boolean>('bot.useMemory');
    const maxResponseLength = this.configService.get<number>('bot.maxLengthResponse');
    const personality = this.getPersonality();

    // Cuatro lecturas independientes a Mongo, antes serializadas una tras
    // otra (route → getForUser → grafo): el aggregate con $lookup del
    // router es el más caro y corría delante de las otras incluso para
    // un mensaje casual. Con `Promise.all` corren en paralelo.
    //
    // El fallback del router se mantiene igual: si `route` rechaza, se usa
    // el prompt completo (perder tokens es aceptable; perder una feature
    // porque faltó su bloque, no). Cada `.catch()` va ANTES del
    // `Promise.all` para que un rechazo de una no tumbe a las otras
    // (`Promise.all` rechaza entera ante el primer rechazo).
    const blocksPromise = this.intentRouter
      .route(message, { useMemory, username })
      .catch((err) => {
        this.logger.warn(`El router falló, se usa el prompt completo: ${(err as Error)?.message}`);
        return [...ALL_BLOCKS];
      });
    const contextPromise = this.contextService.getForUser(username ?? '');
    const graphContextPromise = this.graphContext
      .build(username ?? '', message)
      .catch(() => '');

    const [blocks, context, graphLine] = await Promise.all([
      blocksPromise,
      contextPromise,
      graphContextPromise,
    ]);

    const systemPrompt = this.promptBuilder.build({
      botName, username, maxLength: maxResponseLength ?? 200,
      personality, useMemory, now: new Date(), blocks,
    });

    // Optimized payload structure to reduce token usage
    const messages: Array<{role: 'system' | 'user' | 'assistant', content: string}> = [
      { role: 'system', content: systemPrompt }
    ];

    // Agregar instrucción específica para saludos simples. Delegado a
    // `IntentRouterService.isSimpleGreeting` — antes esta clase sostenía su
    // propia regex, más angosta (sin "<saludo> bot", sin des-acentuar, sin
    // puntuación repetida), que divergía de la del router para casos como
    // "hey bot", "qué tal" (con tilde) o "hola!!": esos mensajes recibían el
    // prompt recortado de saludo (por el router) pero NO el tope de 50
    // tokens, la `temperature: 0.3` ni la etiqueta `greeting` en `intents`
    // (que dependían de esta regex). Una sola fuente evita la divergencia.
    const isSimpleGreeting = this.intentRouter.isSimpleGreeting(message);
    if (isSimpleGreeting) {
      messages.push({
        role: 'system',
        content: `El usuario te está saludando de forma simple. Responde de manera breve y amigable, máximo 1-2 frases cortas. Ejemplos: "¡Hola! ¿Cómo estás?" o "¡Hey! ¿En qué puedo ayudarte?"`
      });
    }

    // Contexto del grafo de conocimiento: reemplaza el volcado de las
    // últimas memorias guardadas por lo relevante a la pregunta (Fase 4b).
    // Si `graphLine` viene vacía (sin datos en el grafo, o falló la lectura),
    // no se empuja ningún mensaje — un mensaje de contenido vacío gastaría
    // una entrada del array para nada.
    let graphContextInjected = false;
    if (graphLine && graphLine.trim().length > 0) {
      messages.push({
        role: 'system',
        content: graphLine,
      });
      graphContextInjected = true;
    }

    // Add conversation context more efficiently
    if (context && context.length > 0) {
      context.forEach(({ question, answer, user }: any) => {
        // Incluir el nombre del usuario en el contexto histórico si está disponible
        const userQuestion = user ? `${user}: ${question}` : question;
        messages.push(
          { role: 'user', content: userQuestion },
          { role: 'assistant', content: answer }
        );
      });
    }

    // Add current user message with username for clarity
    messages.push({ role: 'user', content: `${username}: ${message}` });

    try {
      // Configurar límite de tokens basado en el tipo de mensaje
      const isResumenRequest = message.toLowerCase().match(/(resumen|resume|qué pasó en el chat|de qué hablaron|que se habló|resúmeme|recap)/);
      const baseMaxTokens = maxResponseLength;
      
      let maxTokens = baseMaxTokens;
      if (isSimpleGreeting) {
        maxTokens = Math.min(50, baseMaxTokens); // Máximo 50 tokens para saludos
        console.log(`🤝 Saludo simple detectado, limitando a ${maxTokens} tokens`);
      } else if (isResumenRequest) {
        maxTokens = Math.max(baseMaxTokens, 300); // Mínimo 300 tokens para resúmenes
        console.log(`📋 Solicitud de resumen detectada, usando ${maxTokens} tokens`);
      }
      
      const response = await this.openai.chat.completions.create({
        messages: messages as any,
        model: this.configService.get('openai.model') || 'gpt-3.5-turbo',
        temperature: isSimpleGreeting ? 0.3 : 0.7, // Temperatura baja para saludos
        max_tokens: maxTokens,
      });

      // Segmenta la fila por lo que hace variar el prompt: promptTokens de
      // kind:'chat' es bimodal entre las personas default/unfiltered de
      // `PromptBuilderService` (toggleable en vivo con !personality), y
      // saludos/memoria/bloques del router también cambian el largo del
      // prompt. Sin esto, la línea base y la fase 3 podrían caer en mezclas
      // distintas de estas variantes sin forma de auditarlo después.
      const intents: string[] = [personality === 'unfiltered' ? 'persona:unfiltered' : 'persona:default'];
      if (isSimpleGreeting) intents.push('greeting');
      if (graphContextInjected) intents.push('graph');
      intents.push(...blocks);

      this.registrarUso('chat', response, username, intents);

      let content = response.choices[0].message.content || '';
      console.log(`Respuesta de OpenAI: ${content}`);
      
      // Verificar si contiene token de resumen ANTES del procesamiento
      const containsResumenToken = content.includes('{{resumen}}');
      console.log(`🔍 Contiene token {{resumen}}: ${containsResumenToken}`);
      console.log(`🎯 Es solicitud de resumen: ${!!isResumenRequest}`);
      
      // Si es una solicitud de resumen pero OpenAI no incluyó el token, forzarlo
      if (isResumenRequest && !containsResumenToken) {
        console.log('🔧 Forzando inserción del token {{resumen}} porque OpenAI lo omitió...');
        if (content.includes('📋✨')) {
          content = content.replace('📋✨', '📋✨ {{resumen}}');
        } else if (content.toLowerCase().includes('resumen del chat')) {
          content = content.replace(/resumen del chat/i, 'resumen del chat {{resumen}}');
        } else if (content.toLowerCase().includes('generar resumen') && content.toLowerCase().includes('resumen')) {
          content = content.replace(/generar.*resumen/i, match => `${match} {{resumen}}`);
        } else {
          // Como último recurso, agregarlo al final
          content += ' {{resumen}}';
        }
        console.log(`✅ Token {{resumen}} insertado forzadamente. Nueva respuesta: ${content}`);
      }
      
      if (containsResumenToken) {
        console.log(`📍 Posición del token en respuesta original: ${content.indexOf('{{resumen}}')}`);
      }
      
      // Procesar función de memoria si está habilitada
      if (useMemory && content.includes('SAVE_MEMORY(')) {
        const memoryResults = this.extractMemoryFromResponse(content, username);
        content = memoryResults.cleanContent;
        
        // Verificación adicional: el token debería estar preservado por extractMemoryFromResponse
        const finalContainsResumenToken = content.includes('{{resumen}}');
        if (containsResumenToken && !finalContainsResumenToken) {
          console.log('⚠️ FALLO CRÍTICO: Token {{resumen}} se perdió a pesar de las protecciones, forzando restauración...');
          // Forzar restauración como último recurso
          if (content.includes('📋✨')) {
            content = content.replace('📋✨', '📋✨ {{resumen}}');
          } else {
            content += ' {{resumen}}';
          }
        }
        
        // Guardar todas las memorias extraídas
        for (const memoryItem of memoryResults.memoriesToSave) {
          if (this.isMemoryWorthSaving(memoryItem, username)) {
            await this.memoryService.saveMemory(memoryItem, username);
            console.log(`💾 Memoria guardada para ${username}: ${memoryItem}`);
          }
        }
      }

      // Sanitizar enlaces de Discord en la respuesta: eliminar paréntesis, corchetes o comillas adyacentes
      try {
        const discordSanitizeRegex = /[\(\[\<"'\uFF08\uFF09]*?(https?:\/\/(?:www\.)?discord\.gg\/[A-Za-z0-9_-]+)[\)\]\>"'\uFF08\uFF09]*/gi;
        content = content.replace(discordSanitizeRegex, '$1');
      } catch (e) {
        console.log('Error sanitizando enlace de Discord:', e);
      }

      // Sin usuario no hay hilo al que pertenecer: antes se guardaba como
      // 'unknown', que en la práctica era un cajón compartido.
      if (username) {
        await this.contextService.save({ question: message, answer: content || '', user: username });
      }

      console.log(`Respuesta generada: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
      
      return content;
    } catch (error) {
      console.error('Error en chat GPT:', error);
      return 'Lo siento, ocurrió un error al procesar tu mensaje. 😅';
    }
  }

  /**
   * Traduce un texto cualquiera al español. Pensado para la sinopsis de
   * AniList (siempre en inglés) — el modelo recibe instrucción muy contenida
   * para evitar que agregue comentarios o cambie la voz del original. Si la
   * llamada falla, devuelve el texto original para no romper el flujo.
   */
  async translateToSpanish(text: string, username?: string): Promise<string> {
    const input = (text ?? '').trim();
    if (!input) return '';

    try {
      const response = await this.openai.chat.completions.create({
        messages: [
          {
            role: 'system',
            content:
              'Eres un traductor. Traduces el texto al español neutro manteniendo el tono y la voz original. NO agregues introducciones, comentarios, notas ni resúmenes. NO uses comillas alrededor. Devuelve únicamente la traducción del texto, nada más.',
          },
          { role: 'user', content: input },
        ],
        model: this.configService.get('openai.model') || 'gpt-3.5-turbo',
        temperature: 0.2,
        max_tokens: Math.max(400, Math.ceil(input.length * 1.5)),
      });

      this.registrarUso('translate', response, username);

      const out = response.choices[0]?.message?.content?.trim();
      return out && out.length > 0 ? out : input;
    } catch (err) {
      console.error('Error traduciendo al español:', err);
      return input;
    }
  }

  async generateSummary(username?: string): Promise<string> {
    const messages = await this.loggingService.getLastMessages();
    
    if (!messages || messages.length === 0) {
      return 'No hay mensajes para resumir en este momento. 🤷‍♂️';
    }

    // Filtrar y limpiar mensajes para el resumen
    const cleanMessages = messages
      .filter((msg: any) => msg.message && msg.message.trim().length > 0)
      .slice(-50) // Últimos 50 mensajes
      .map((msg: any) => `${msg.user}: ${msg.message}`)
      .join('\n');

    if (!cleanMessages.trim()) {
      return 'No hay contenido suficiente para generar un resumen. 🤷‍♂️';
    }

    try {
      const summaryResponse = await this.openai.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: `Eres un asistente que genera resúmenes concisos de conversaciones de chat sobre anime, manga y entretenimiento.

INSTRUCCIONES PARA EL RESUMEN:
- Crea un resumen organizado y fácil de leer
- Agrupa los temas principales discutidos
- Menciona a los usuarios más activos y sus contribuciones principales
- Incluye títulos de anime/manga/series mencionados
- Mantén un tono amigable y entretenido
- Usa emojis relevantes para hacer el resumen más visual
- Evita detalles muy específicos o conversaciones privadas
- Si hay recomendaciones de anime/manga, inclúyelas
- Máximo 800 caracteres por mensaje (se dividirá automáticamente si es necesario)

FORMATO SUGERIDO:
🎯 Temas principales: [lista de temas]
👥 Usuarios más activos: [nombres]
📺 Anime/Manga mencionados: [títulos]
💬 Momento destacado: [algo interesante que pasó]
🎮 Otros temas: [gaming, música, etc.]`
          },
          {
            role: 'user',
            content: `Genera un resumen de esta conversación de chat:\n\n${cleanMessages}`
          }
        ],
        model: this.configService.get('openai.model') || 'gpt-3.5-turbo',
        temperature: 0.7,
        max_tokens: 500,
      });

      this.registrarUso('summary', summaryResponse, username);

      const summary = summaryResponse.choices[0].message.content || '';
      console.log(`✅ Resumen generado: ${summary.substring(0, 100)}...`);
      
      return summary;
    } catch (error) {
      console.error('Error generando resumen:', error);
      return '❌ Error al generar el resumen. Intenta más tarde.';
    }
  }

  /**
   * Registra el consumo de una llamada al modelo. Fire-and-forget a propósito:
   * medir no puede sumar latencia a la respuesta ni romperla si Mongo falla.
   * `usage` es opcional en la respuesta según el proveedor detrás de
   * OPENAI_BASE_URL, de ahí los `?? 0`. Si `usage` viene undefined, la línea
   * queda en 0/0 indistinguible de una medición real — se avisa una sola vez
   * por proceso para que no pase desapercibido.
   */
  private registrarUso(
    kind: LlmKind,
    response: {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    },
    user?: string,
    intents?: string[],
  ): void {
    if (!response.usage && !this.usageMissingWarned) {
      this.usageMissingWarned = true;
      this.logger.warn(
        `El proveedor detrás de OPENAI_BASE_URL no devolvió "usage" en la respuesta. ` +
          `La medición de tokens (línea base para la fase 3) va a quedar en 0/0 y no va a servir con este proveedor.`,
      );
    }

    void this.usageService
      .record({
        kind,
        user: user ?? '',
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        cachedPromptTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        model: this.configService.get<string>('openai.model') ?? '',
        intents: intents ?? [],
      })
      .catch(() => {});
  }

  private extractMemoryFromResponse(content: string, username?: string): { cleanContent: string; memoriesToSave: string[] } {
    const memoriesToSave: string[] = [];
    
    // Buscar todas las instancias de SAVE_MEMORY usando regex más robusto
    const memoryRegex = /SAVE_MEMORY\s*\(\s*['"](.*?)['"]\s*\)/g;
    let match;
    
    while ((match = memoryRegex.exec(content)) !== null) {
      const memoryContent = match[1].trim();
      if (memoryContent && memoryContent.length > 5) {
        memoriesToSave.push(memoryContent);
      }
    }
    
    // Limpiar el contenido removiendo todas las llamadas SAVE_MEMORY
    // CRÍTICO: Preservar {{resumen}} si existe
    const hasResumenToken = content.includes('{{resumen}}');
    let cleanContent = content.replace(memoryRegex, '').trim();
    
    // Restaurar {{resumen}} si se perdió durante la limpieza
    if (hasResumenToken && !cleanContent.includes('{{resumen}}')) {
      console.log('🔧 Restaurando token {{resumen}} después de limpiar memoria...');
      cleanContent += ' {{resumen}}';
    }
    
    // Limpiar líneas vacías múltiples
    cleanContent = cleanContent.replace(/\n\s*\n\s*\n/g, '\n\n');
    
    return { cleanContent, memoriesToSave };
  }

  private isMemoryWorthSaving(memory: string, username?: string): boolean {
    if (!memory || memory.trim().length < 10) return false;
    
    // Lista de patrones que NO valen la pena guardar
    const unworthyPatterns = [
      /información general/i,
      /el usuario preguntó/i,
      /usuario mencionó/i,
      /conversación sobre/i,
      /hablamos de/i,
      /^(sí|si|no|ok|okay|bien|bueno|perfecto)$/i,
      /^gracias/i,
      /^hola/i,
      /debo recordar/i,
      /es importante/i,
      /tomar nota/i
    ];
    
    // Verificar si coincide con algún patrón no deseado
    const isUnworthy = unworthyPatterns.some(pattern => pattern.test(memory));
    if (isUnworthy) {
      console.log(`🚫 Memoria descartada por ser genérica: "${memory}"`);
      return false;
    }
    
    // Patrones que SÍ valen la pena (información específica y útil)
    const worthyPatterns = [
      /le gusta|favorito|prefiere/i,
      /años|edad/i,
      /país|ciudad|lugar/i,
      /anime:|manga:|manhwa:/i,
      /recomendación/i,
      /nombre.*es/i,
      /trabaja|estudia|profesión/i
    ];
    
    const isWorthy = worthyPatterns.some(pattern => pattern.test(memory));
    if (isWorthy) {
      console.log(`✅ Memoria aprobada por ser específica: "${memory}"`);
      return true;
    }
    
    // Si no coincide con ningún patrón, evaluar por longitud y contenido específico
    const hasSpecificInfo = memory.includes(username || '') || 
                           memory.length > 30 || 
                           /[A-Z][a-z]+/.test(memory); // Contiene nombres propios
    
    if (hasSpecificInfo) {
      console.log(`✅ Memoria aprobada por contenido específico: "${memory}"`);
      return true;
    }
    
    console.log(`🤔 Memoria descartada por falta de especificidad: "${memory}"`);
    return false;
  }

  /**
   * Active personality, preferring a runtime override over the env default.
   * The override is set by admins via !personality and is wiped on restart.
   */
  getPersonality(): BotPersonality {
    if (this.personalityOverride) return this.personalityOverride;
    return this.configService.get<BotPersonality>('bot.personality') ?? 'default';
  }

  /** Current value plus where it came from — useful for the status reply. */
  getPersonalityInfo(): { current: BotPersonality; source: 'override' | 'env' } {
    if (this.personalityOverride) return { current: this.personalityOverride, source: 'override' };
    const envValue = this.configService.get<BotPersonality>('bot.personality') ?? 'default';
    return { current: envValue, source: 'env' };
  }

  /** Set or clear the runtime personality override. Pass null to revert to .env. */
  setPersonalityOverride(value: BotPersonality | null): void {
    this.personalityOverride = value;
  }
}