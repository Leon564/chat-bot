import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { LoggingService } from '../../common/utils/logging.service';
import { ContextService } from './context.service';
import { UsageService } from './usage.service';
import { LlmKind } from '../../common/schemas/llm-usage.schema';
import { PromptBuilderService, ALL_BLOCKS } from './prompt-builder.service';
import { IntentRouterService } from './intent-router.service';
import { GraphContextService } from '../graph/graph-context.service';
import { GraphIngestService } from '../graph/graph-ingest.service';

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
    private readonly loggingService: LoggingService,
    private readonly contextService: ContextService,
    private readonly usageService: UsageService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly intentRouter: IntentRouterService,
    private readonly graphContext: GraphContextService,
    private readonly graphIngest: GraphIngestService,
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
      
      // Procesar hechos SAVE_FACT si la memoria está habilitada. Reemplaza al
      // SAVE_MEMORY de texto libre (Task 4, fase 4b): el sujeto siempre es
      // `username` (nunca se lee del texto del modelo), y la relación tiene
      // que caer en el enum cerrado que valida `GraphIngestService.ingestFact`.
      if (useMemory && content.includes('SAVE_FACT(')) {
        const factResults = this.extractFactsFromResponse(content);
        content = factResults.cleanContent;

        // Verificación adicional: el token debería estar preservado por extractFactsFromResponse
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

        // Ingestar todos los hechos extraídos. Sin username no hay sujeto al
        // que atribuírselos — `ingestFact` además revalida relación y objeto,
        // esto es sólo la guarda de "no hay usuario".
        if (username) {
          for (const fact of factResults.facts) {
            await this.graphIngest.ingestFact(username, fact.relation, fact.object);
            console.log(`💾 Hecho ingresado para ${username}: SAVE_FACT(${fact.relation}, ${fact.object})`);
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

  async generateSummary(username?: string): Promise<{
    text: string;
    facts: Array<{ user: string; relation: string; object: string }>;
  }> {
    const messages = await this.loggingService.getLastMessages();

    if (!messages || messages.length === 0) {
      return { text: 'No hay mensajes para resumir en este momento. 🤷‍♂️', facts: [] };
    }

    // Filtrar y limpiar mensajes para el resumen
    const cleanMessages = messages
      .filter((msg: any) => msg.message && msg.message.trim().length > 0)
      .slice(-50) // Últimos 50 mensajes
      .map((msg: any) => `${msg.user}: ${msg.message}`)
      .join('\n');

    if (!cleanMessages.trim()) {
      return { text: 'No hay contenido suficiente para generar un resumen. 🤷‍♂️', facts: [] };
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
🎮 Otros temas: [gaming, música, etc.]

Después del resumen, agregá una línea con exactamente <<<HECHOS>>> y debajo,
un hecho por línea con el formato usuario|relación|objeto, usando sólo las
relaciones likes, dislikes o asked_about. Si no encontraste ninguno, no
escribas nada después del delimitador.`
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

      const raw = summaryResponse.choices[0].message.content || '';
      const { text, facts } = this.parseSummaryAndFacts(raw);
      console.log(`✅ Resumen generado: ${text.substring(0, 100)}...`);

      return { text, facts };
    } catch (error) {
      console.error('Error generando resumen:', error);
      return { text: '❌ Error al generar el resumen. Intenta más tarde.', facts: [] };
    }
  }

  /**
   * Separa el resumen del bloque de hechos que el modelo agrega al final
   * (Task 5, fase 4b) — ninguna llamada nueva al modelo, sólo aprovecha la
   * respuesta que `generateSummary` ya pide. El parseo es defensivo porque el
   * modelo puede no seguir el formato pedido en el prompt:
   *   - Sin el delimitador `<<<HECHOS>>>`, todo el texto es el resumen y no
   *     hay hechos — nunca se asume que el modelo lo va a emitir.
   *   - Con el delimitador, el resumen es lo anterior a él y los hechos son
   *     las líneas posteriores que tengan EXACTAMENTE tres partes separadas
   *     por `|` (usuario|relación|objeto). Cualquier línea que no matchee
   *     (vacía, sin pipes, con pipes de más) se descarta en silencio — no
   *     rompe el resumen ni el resto de los hechos bien formados.
   * La validación de la relación contra el enum cerrado y la sanitización del
   * objeto quedan en `GraphIngestService.ingestFact`, que es quien las
   * ingesta — acá sólo se separa el texto.
   */
  private parseSummaryAndFacts(raw: string): {
    text: string;
    facts: Array<{ user: string; relation: string; object: string }>;
  } {
    const delimiterIndex = raw.indexOf(ChatService.FACTS_DELIMITER);
    if (delimiterIndex === -1) {
      return { text: raw.trim(), facts: [] };
    }

    const text = raw.slice(0, delimiterIndex).trim();
    const factsBlock = raw.slice(delimiterIndex + ChatService.FACTS_DELIMITER.length);

    const facts: Array<{ user: string; relation: string; object: string }> = [];
    for (const rawLine of factsBlock.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      const parts = line.split('|').map((p) => p.trim());
      if (parts.length !== 3) continue;

      const [user, relation, object] = parts;
      facts.push({ user, relation, object });
    }

    return { text, facts };
  }

  /** Delimitador que separa el resumen del bloque de hechos en la respuesta cruda del modelo. */
  private static readonly FACTS_DELIMITER = '<<<HECHOS>>>';

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

  /**
   * Extrae los pares (relación, objeto) de todas las llamadas
   * `SAVE_FACT(relación, objeto)` presentes en la respuesta del modelo y
   * devuelve el texto limpio de esas llamadas. Reemplaza a
   * `extractMemoryFromResponse` (Task 4, fase 4b): antes se extraía una
   * frase de texto libre que había que clasificar con heurísticas
   * (`isMemoryWorthSaving`, ya eliminado); ahora la validez de cada hecho la
   * da el enum cerrado de relaciones en `GraphIngestService.ingestFact`, no
   * un conjunto de patrones acá.
   *
   * Conserva la misma protección explícita del token `{{resumen}}` que tenía
   * `extractMemoryFromResponse`: si la respuesta traía el token antes de
   * limpiar los SAVE_FACT y la limpieza (por la razón que sea) se lo llevó
   * puesto, se restaura al final en vez de perderlo — un resumen pedido no
   * puede volverse silenciosamente en un resumen que nunca se genera sólo
   * porque el modelo también emitió un hecho en la misma respuesta.
   */
  private extractFactsFromResponse(content: string): {
    cleanContent: string;
    facts: Array<{ relation: string; object: string }>;
  } {
    const facts: Array<{ relation: string; object: string }> = [];

    const factRegex = /SAVE_FACT\s*\(\s*([a-z_]+)\s*,\s*([^)]+)\)/gi;
    let match: RegExpExecArray | null;

    while ((match = factRegex.exec(content)) !== null) {
      const relation = match[1].trim().toLowerCase();
      const object = match[2].trim();
      if (relation && object) {
        facts.push({ relation, object });
      }
    }

    // Limpiar el contenido removiendo todas las llamadas SAVE_FACT.
    // CRÍTICO: Preservar {{resumen}} si existe.
    const hasResumenToken = content.includes('{{resumen}}');
    let cleanContent = content.replace(factRegex, '').trim();

    // Restaurar {{resumen}} si se perdió durante la limpieza.
    if (hasResumenToken && !cleanContent.includes('{{resumen}}')) {
      console.log('🔧 Restaurando token {{resumen}} después de limpiar SAVE_FACT...');
      cleanContent += ' {{resumen}}';
    }

    // Limpiar líneas vacías múltiples.
    cleanContent = cleanContent.replace(/\n\s*\n\s*\n/g, '\n\n');

    return { cleanContent, facts };
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