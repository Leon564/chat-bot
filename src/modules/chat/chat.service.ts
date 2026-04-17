import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { MemoryService } from '../../common/utils/memory.service';
import { LoggingService } from '../../common/utils/logging.service';

@Injectable()
export class ChatService {
  private openai: OpenAI;

  constructor(
    private readonly configService: ConfigService,
    private readonly memoryService: MemoryService,
    private readonly loggingService: LoggingService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('openai.apiKey'),
      baseURL: this.configService.get<string>('openai.baseURL') || 'https://api.openai.com/v1',
    });
  }

  async chat(message: string, botName?: string, username?: string): Promise<string> {
    const rules = '[scroll] 1. Sé respetuoso [/scroll] [scroll]2. Nada de spam o links sospechosos [/scroll] [scroll] 3. No contenido ilegal 🌀 [/scroll] [scroll] 3. No compartir información personal o redes sociales 🌀 [/scroll] ¡Disfruta del chat y del manga!';

    // Generar instrucciones de memoria dinámicamente usando función especial
    const useMemory = this.configService.get<boolean>('bot.useMemory');
    const memoryInstructions = useMemory 
      ? `\n\nSISTEMA DE MEMORIA:
Si quieres guardar información importante sobre ${username}, usa esta función exacta al final de tu respuesta:
SAVE_MEMORY("información específica y valiosa")

Guarda solo:
- Preferencias del usuario (gustos, géneros favoritos)
- Recomendaciones específicas hechas
- Información personal relevante del usuario
- Datos únicos de la conversación

NO uses SAVE_MEMORY para información genérica o repetitiva.
La función debe estar en una línea separada al final de tu respuesta.`
      : '';

    // Generar contexto de fecha y hora actual
    const currentDate = new Date();
    const specialDay = this.getSpecialDay(currentDate);
    const specialDayText = specialDay ? `\n- Evento especial: ${specialDay}` : '';
    
    const dateTimeContext = `
CONTEXTO TEMPORAL ACTUAL:
- Fecha: ${currentDate.toLocaleDateString('es-ES', { 
  weekday: 'long', 
  year: 'numeric', 
  month: 'long', 
  day: 'numeric' 
})}
- Hora: ${currentDate.toLocaleTimeString('es-ES', { 
  hour: '2-digit', 
  minute: '2-digit',
  timeZone: 'America/El_Salvador'
})} (hora de El Salvador)
- Es ${this.getTimeOfDay(currentDate)} del ${this.getDayType(currentDate)}${specialDayText}`;

    const maxResponseLength = this.configService.get<number>('bot.maxLengthResponse');
    const systemPrompt = `Eres ${botName}, un asistente especializado en anime, manga y manhwa que responde a ${username}.
${dateTimeContext}

REGLAS PRINCIPALES:
1. Máximo ${maxResponseLength} caracteres por respuesta
2. Sé MUY BREVE: 1-2 frases cortas para la mayoría de mensajes, como si fuera un chat casual entre amigos. Solo extiéndete si alguien pide algo específico (recomendaciones, listas, resúmenes).
3. Tono informal y relajado: usa lenguaje coloquial, emojis ocasionales, nada de respuestas tipo ensayo.
4. No menciones que eres un bot
5. Nunca uses listas ni bullets para respuestas simples; guárdalos solo si la situación lo justifica.

COMANDOS DE MÚSICA:
- Cuando soliciten música ("reproduce [canción]", "!music [canción]"), confirma que el sistema la procesará
- NO reproduzcas música tú mismo, solo confirma la solicitud

INFORMACIÓN PERSONAL (solo si preguntan):
- Creador/Padre: Leon564 (<@Sleepy Ash>)
- Madre: <@Isis>
- Hermanos: <@kei> y <@Lyna>
- Propósito: Ayudar en el chat por órdenes de Leon564
  - Reglas del chat: ${rules}
  - Discord: ${process.env.DISCORD_URL || 'https://discord.gg/n53r5Py2eD'}
  - Nota: Si preguntan por Discord, responde únicamente con el enlace limpio sin paréntesis, corchetes ni caracteres adyacentes (ej.: https://discord.gg/ejemplo)

RESÚMENES DEL CHAT:
Si ${username} pide un resumen (palabras clave: resumen, resume, qué pasó, recap, etc.), responde:
"¡Perfecto! Voy a generar un resumen del chat 📋✨ {{resumen}}"

USUARIOS EN LÍNEA:
Si ${username} pregunta sobre usuarios conectados, gente en línea, quién está aquí, cuántas personas hay, etc., responde:
"¡Aquí tienes la lista de quién está en línea! 👥 {{usuarios_online}}"

Ejemplos de cuándo usar {{usuarios_online}}:
- "¿quién está aquí?"
- "¿hay alguien más?"
- "¿cuántas personas hay?"
- "¿quién anda por aquí?"
- "mostrar usuarios"
- "ver quién está"
- "¿está [nombre] conectado?"
- "¿quién está disponible?"
- "listar gente"
- "¿quién más está en el chat?"
- "usuarios activos"
- "gente conectada"

CRÍTICO: Incluye SIEMPRE el token {{resumen}} cuando se solicite un resumen y {{usuarios_online}} cuando pregunten sobre usuarios conectados.${memoryInstructions}${this.generateMemoryExamples(username)}

Mantén conversaciones naturales y enfócate en anime, manga y manhwa con ${username}.`;

    const context = await this.getContext();
    const memory = useMemory ? await this.memoryService.getMemory(username) : [];

    // Optimized payload structure to reduce token usage
    const messages: Array<{role: 'system' | 'user' | 'assistant', content: string}> = [
      { role: 'system', content: systemPrompt }
    ];

    // Agregar instrucción específica para saludos simples
    const isSimpleGreeting = message.toLowerCase().match(/^(@\w+\s+)?(hola|hi|hey|hello|como estas|que tal|buenas|saludos|bot)(\?|\!|\.)?$/i);
    if (isSimpleGreeting) {
      messages.push({
        role: 'system',
        content: `El usuario te está saludando de forma simple. Responde de manera breve y amigable, máximo 1-2 frases cortas. Ejemplos: "¡Hola! ¿Cómo estás?" o "¡Hey! ¿En qué puedo ayudarte?"`
      });
    }

    // Add memory context if available (optimized and filtered) and enabled
    if (useMemory && memory && memory.length > 0) {
      // Solo usar memoria relevante, máximo 3 elementos
      const relevantMemories = memory.slice(-3);
      if (relevantMemories.length > 0) {
        messages.push({
          role: 'system', 
          content: `Contexto relevante recordado: ${relevantMemories.join(' | ')}`
        });
      }
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

      await this.saveContext({ question: message, answer: content || '', user: username || 'unknown' });

      console.log(`Respuesta generada: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
      
      return content;
    } catch (error) {
      console.error('Error en chat GPT:', error);
      return 'Lo siento, ocurrió un error al procesar tu mensaje. 😅';
    }
  }

  async generateSummary(): Promise<string> {
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

      const summary = summaryResponse.choices[0].message.content || '';
      console.log(`✅ Resumen generado: ${summary.substring(0, 100)}...`);
      
      return summary;
    } catch (error) {
      console.error('Error generando resumen:', error);
      return '❌ Error al generar el resumen. Intenta más tarde.';
    }
  }

  private async getContext(): Promise<any[]> {
    const contextPath = require('path').join(process.cwd(), 'data', 'context.json');
    const fs = require('fs');
    
    try {
      // Crear directorio si no existe
      const dirPath = require('path').dirname(contextPath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      
      if (fs.existsSync(contextPath)) {
        const contextData = fs.readFileSync(contextPath, 'utf-8');
        return JSON.parse(contextData);
      }
    } catch (error) {
      console.error('Error loading context:', error);
    }
    
    return [];
  }

  private async saveContext(contextItem: { question: string; answer: string; user: string }): Promise<void> {
    const contextPath = require('path').join(process.cwd(), 'data', 'context.json');
    const fs = require('fs');
    
    try {
      // Crear directorio si no existe
      const dirPath = require('path').dirname(contextPath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      
      let context = [];
      if (fs.existsSync(contextPath)) {
        const contextData = fs.readFileSync(contextPath, 'utf-8');
        context = JSON.parse(contextData);
      }
      
      context.push(contextItem);
      
      // Mantener solo los últimos 10 intercambios
      if (context.length > 10) {
        context = context.slice(-10);
      }
      
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));
    } catch (error) {
      console.error('Error saving context:', error);
    }
  }

  private generateMemoryExamples(username?: string): string {
    if (!this.configService.get<boolean>('bot.useMemory')) return '';
    
    return `

EJEMPLOS DE USO DE MEMORIA:
Correcto:
Usuario: "Me gusta mucho Attack on Titan"
Respuesta: "¡Excelente elección! Attack on Titan es increíble. SAVE_MEMORY("${username} le gusta Attack on Titan")"

Usuario: "Tengo 25 años"
Respuesta: "Perfecto, a los 25 tienes mucha experiencia con anime 😊 SAVE_MEMORY("${username} tiene 25 años")"

Incorrecto:
SAVE_MEMORY("El usuario preguntó algo") ❌
SAVE_MEMORY("Información general") ❌`;
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
   * Obtiene el periodo del día basado en la hora
   */
  private getTimeOfDay(date: Date): string {
    const hour = date.getHours();
    
    if (hour >= 6 && hour < 12) {
      return 'mañana';
    } else if (hour >= 12 && hour < 18) {
      return 'tarde';
    } else if (hour >= 18 && hour < 24) {
      return 'noche';
    } else {
      return 'madrugada';
    }
  }

  /**
   * Obtiene el tipo de día (laboral/fin de semana)
   */
  private getDayType(date: Date): string {
    const dayOfWeek = date.getDay();
    
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return 'fin de semana';
    } else if (dayOfWeek === 5) {
      return 'viernes';
    } else if (dayOfWeek === 1) {
      return 'lunes';
    } else {
      return 'día de semana';
    }
  }

  /**
   * Detecta días especiales o eventos
   */
  private getSpecialDay(date: Date): string | null {
    const month = date.getMonth() + 1; // getMonth() returns 0-11
    const day = date.getDate();
    
    // Días festivos y eventos especiales
    const specialDays: { [key: string]: string } = {
      '1/1': 'Año Nuevo',
      '2/14': 'Día de San Valentín',
      '5/10': 'Día de las Madres (México)',
      '9/16': 'Día de la Independencia de México',
      '10/31': 'Halloween',
      '11/1': 'Día de Todos los Santos',
      '11/2': 'Día de Muertos',
      '12/12': 'Día de la Virgen de Guadalupe',
      '12/24': 'Nochebuena',
      '12/25': 'Navidad',
      '12/31': 'Año Viejo'
    };

    const key = `${month}/${day}`;
    return specialDays[key] || null;
  }
}