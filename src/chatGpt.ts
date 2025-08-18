import "dotenv/config";
import path from "path";
import fs from "fs";
import Openai from "openai";
import { getLastMessages, getMemory, saveMemory } from "./utils";

export class Gpt {
  constructor(
    private openai = new Openai({ apiKey: process.env.OPENAI_API_KEY })
  ) {}

  async chat(message: string, botName?: string, username?: string) {
    const rules = "[scroll] 1. Sé respetuoso [/scroll] [scroll]2. Nada de spam o links sospechosos [/scroll] [scroll] 3. No contenido ilegal 🌀 [/scroll] ¡Disfruta del chat y del manga!";

    // Generar instrucciones de memoria dinámicamente usando función especial
    const memoryInstructions = Boolean(process.env.USE_MEMORY) 
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
    // Optimized single system prompt for better coherence and reduced tokens
    const systemPrompt = `Eres ${botName}, un asistente especializado en anime, manga y manhwa.

IMPORTANTE: Estás respondiendo específicamente a ${username}. Cuando menciones "tu creador" o respondas preguntas personales sobre ti, asegúrate de dirigirte a ${username}.

COMPORTAMIENTO:
- Responde de forma natural y coherente, máximo ${process.env.MAX_LENGTH_RESPONSE} caracteres
- Para saludos simples (hola, hi, hey), responde de forma breve y amigable
- Evita repetir información del contexto previo
- No menciones que eres un bot ni repitas tu nombre innecesariamente
- Dirige tu respuesta específicamente a ${username} cuando sea relevante
- Sé conciso: para mensajes cortos, da respuestas cortas; para preguntas complejas, da respuestas detalladas

RESPUESTAS ESPECIALES (solo si preguntan específicamente):
- Tu propósito: Ayudar por órdenes de Leon564 (<@6851018|Sleepy Ash>)
- Tu creador: León564 (<@6851018|Sleepy Ash>)
- Tu padre: Leon564 (<@6851018|Sleepy Ash>)
- Tu madre : @Isis
- Reglas del chat: ${rules}
- Discord: ${process.env.DISCORD_URL || 'https://discord.gg/n53r5Py2eD'}

DETECCIÓN DE SOLICITUD DE RESUMEN:
Si el usuario solicita un resumen del chat de cualquier forma (ej: "resumen", "resume", "qué pasó", "de qué hablaron", "que se habló", "resúmeme", "recap", etc.), DEBES responder EXACTAMENTE con este formato:
"¡Perfecto! Voy a generar un resumen del chat 📋✨ {{resumen}}"

CRÍTICO: El token {{resumen}} es OBLIGATORIO y debe aparecer al final del mensaje cuando se solicite un resumen. NO omitas {{resumen}} bajo ninguna circunstancia.

IMPORTANTE: La palabra {{resumen}} debe aparecer SIEMPRE en la respuesta cuando se solicite un resumen.${memoryInstructions}${this.generateMemoryExamples(username)}

Sé conciso y relevante en tus respuestas dirigidas a ${username}.`;

    const context = await this.getContext();
    const memory = Boolean(process.env.USE_MEMORY) ? await getMemory(username) : [];

    // Optimized payload structure to reduce token usage
    const messages: Array<{role: "system" | "user" | "assistant", content: string}> = [
      { role: "system", content: systemPrompt }
    ];

    // Agregar instrucción específica para saludos simples
    const isSimpleGreeting = message.toLowerCase().match(/^(@\w+\s+)?(hola|hi|hey|hello|como estas|que tal|buenas|saludos)(\?|\!|\.)?$/i);
    if (isSimpleGreeting) {
      messages.push({
        role: "system",
        content: `El usuario te está saludando de forma simple. Responde de manera breve y amigable, máximo 1-2 frases cortas. Ejemplos: "¡Hola! ¿Cómo estás?" o "¡Hey! ¿En qué puedo ayudarte?"`
      });
    }

    // Add memory context if available (optimized and filtered) and enabled
    if (Boolean(process.env.USE_MEMORY) && memory && memory.length > 0) {
      // Solo usar memoria relevante, máximo 3 elementos
      const relevantMemories = memory.slice(-3);
      if (relevantMemories.length > 0) {
        messages.push({
          role: "system", 
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
          { role: "user", content: userQuestion },
          { role: "assistant", content: answer }
        );
      });
    }

    // Add current user message with username for clarity
    messages.push({ role: "user", content: `${username}: ${message}` });

    const payload = { messages };

    try {
      // Configurar límite de tokens basado en el tipo de mensaje
      // (isSimpleGreeting ya está definido arriba)
      const isResumenRequest = message.toLowerCase().match(/(resumen|resume|qué pasó|de qué hablaron|que se habló|resúmeme|recap)/);
      const baseMaxTokens = parseInt(process.env.MAX_LENGTH_RESPONSE || "199");
      
      let maxTokens = baseMaxTokens;
      if (isSimpleGreeting) {
        maxTokens = Math.min(50, baseMaxTokens); // Máximo 50 tokens para saludos
        console.log(`🤝 Saludo simple detectado, limitando a ${maxTokens} tokens`);
      } else if (isResumenRequest) {
        maxTokens = Math.max(baseMaxTokens, 300); // Mínimo 300 tokens para resúmenes
        console.log(`📋 Solicitud de resumen detectada, usando ${maxTokens} tokens`);
      }
      
      const response = await this.openai.chat.completions.create({
        messages: payload.messages as any,
        model: "gpt-3.5-turbo",
        temperature: isSimpleGreeting ? 0.3 : 0.7, // Temperatura baja para saludos
        max_tokens: maxTokens,
      });

      // Remove commented code and fix error message
      let content = response.choices[0].message.content || "";
      console.log(`Respuesta de OpenAI: ${content}`);
      
      // Detectar si es una solicitud de resumen por patrones en el mensaje original
      // (Esta variable ya está definida arriba en el try block)
      
      // Verificar si contiene token de resumen ANTES del procesamiento
      const containsResumenToken = content.includes("{{resumen}}");
      console.log(`🔍 Contiene token {{resumen}}: ${containsResumenToken}`);
      console.log(`🎯 Es solicitud de resumen: ${!!isResumenRequest}`);
      
      // Si es una solicitud de resumen pero OpenAI no incluyó el token, forzarlo
      if (isResumenRequest && !containsResumenToken) {
        console.log("🔧 Forzando inserción del token {{resumen}} porque OpenAI lo omitió...");
        if (content.includes("📋✨")) {
          content = content.replace("📋✨", "📋✨ {{resumen}}");
        } else if (content.toLowerCase().includes("resumen del chat")) {
          content = content.replace(/resumen del chat/i, "resumen del chat {{resumen}}");
        } else if (content.toLowerCase().includes("generar") && content.toLowerCase().includes("resumen")) {
          content = content.replace(/generar.*resumen/i, match => `${match} {{resumen}}`);
        } else {
          // Como último recurso, agregarlo al final
          content += " {{resumen}}";
        }
        console.log(`✅ Token {{resumen}} insertado forzadamente. Nueva respuesta: ${content}`);
      }
      
      if (containsResumenToken) {
        console.log(`📍 Posición del token en respuesta original: ${content.indexOf("{{resumen}}")}`);
      }
      
      // Actualizar la variable después de la posible inserción forzada
      const finalContainsResumenToken = content.includes("{{resumen}}");
      
      // Procesar función de memoria si está habilitada
      if (Boolean(process.env.USE_MEMORY) && content.includes("SAVE_MEMORY(")) {
        const memoryResults = this.extractMemoryFromResponse(content, username);
        content = memoryResults.cleanContent;
        
        // Verificación adicional: el token debería estar preservado por extractMemoryFromResponse
        if (finalContainsResumenToken && !content.includes("{{resumen}}")) {
          console.log("⚠️ FALLO CRÍTICO: Token {{resumen}} se perdió a pesar de las protecciones, forzando restauración...");
          // Forzar restauración como último recurso
          if (content.includes("📋✨")) {
            content = content.replace("📋✨", "📋✨ {{resumen}}");
          } else {
            content += " {{resumen}}";
          }
        }
        
        // Guardar todas las memorias extraídas
        for (const memoryItem of memoryResults.memoriesToSave) {
          if (this.isMemoryWorthSaving(memoryItem, username)) {
            await saveMemory(memoryItem, username);
            console.log(`💾 Memoria guardada para ${username}: ${memoryItem}`);
          }
        }
      }

      await this.saveContext({ question: message, answer: content || "", user: username });

      console.log(`Respuesta generada: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
      
      // Log adicional para debugging de resúmenes
      if (content.includes("{{resumen}}")) {
        console.log("✅ Token {{resumen}} preservado en la respuesta final");
        console.log(`📍 Posición final del token: ${content.indexOf("{{resumen}}")}`);
      } else if (message.toLowerCase().includes("resumen") || message.toLowerCase().includes("resume") || message.toLowerCase().includes("recap")) {
        console.log("⚠️ Se solicitó resumen pero no se detectó token {{resumen}} en la respuesta final");
        console.log(`Mensaje original: "${message}"`);
        console.log(`Respuesta final completa: "${content}"`);
        console.log(`Contenía token originalmente: ${containsResumenToken}`);
        console.log(`Contenía token después de procesamiento: ${finalContainsResumenToken}`);
      }
      
      return content || "No hay respuesta disponible.";
    } catch (error) {
      throw error;
    }
  }

  //guarda el contexto de las ultimas preguntas y respuestas con el usuario en un archivo json
  async saveContext({ question, answer, user }: any) {
    const context = await this.getContext();
    const filePath = path.join(__dirname, "../data/context.json");
    context.push({ question, answer, user });
    fs.writeFileSync(
      filePath,
      JSON.stringify(context.slice(-Number(process.env.CONTEXT_LENGTH || 5)))
    );
  }

  //recupera el contexto de las ultimas 3 preguntas y respuestas
  async getContext() {
    const filePath = path.join(__dirname, "../data/context.json");
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data);
    }
    return [];
  }

  async generateSummary() {
    const history = await getLastMessages();
    
    const recentMessages = history;

    console.log(`Generando resumen de los últimos ${recentMessages.length} mensajes...`);
    
    if (recentMessages.length === 0) {
      return "No hay mensajes recientes para resumir.";
    }

    // Filtrar mensajes para mejorar la calidad del resumen
    const filteredMessages = this.filterMessagesForSummary(recentMessages);
    
    console.log(`Filtrando mensajes: ${recentMessages.length} → ${filteredMessages.length} mensajes útiles`);

    // Prompt mejorado para incluir chismes y momentos jugosos
    const systemPrompt = `Genera un resumen entretenido y jugoso de la conversación del chat.
    
Tu username es: ${process.env.CBOX_USERNAME}.

INSTRUCCIONES IMPORTANTES:
- Habla en primera persona como si fueras el bot del chat
- Incluye los CHISMES más interesantes y divertidos
- Menciona las conversaciones más jugosas o entretenidas
- Incluye bromas, momentos graciosos o situaciones curiosas
- Destaca recomendaciones de anime/manga/manhwa importantes
- Menciona discusiones interesantes o debates
- Incluye cualquier drama menor o situaciones divertidas
- Usa un tono casual y entretenido
- Agrega emojis para hacer más ameno el resumen
- Omite solo saludos simples y spam obvio

CONTEXTO ADICIONAL:
- Solo incluye conversaciones que realmente aporten valor
- Agrupa temas relacionados y evita repeticiones
- Si hay pocos temas, profundiza más en cada uno
- Menciona interacciones únicas entre usuarios

FORMATO:
- Frases cortas y directas
- Incluye nombres de usuarios cuando sea relevante
- Agrupa temas relacionados
- Termina con una conclusión divertida o comentario final`;

    if (filteredMessages.length === 0) {
      return "No hay suficientes conversaciones interesantes para resumir. ¡Hagamos que el chat sea más activo! 🎉";
    }

    if (filteredMessages.length < 5) {
      // Si hay muy pocos mensajes, usar todos los mensajes originales pero con mejor análisis
      console.log("Pocos mensajes filtrados, usando todos los mensajes para análisis...");
      const allMessages = recentMessages
        .map(({ user, message }: any) => `${user}: ${message}`)
        .join("\n");
      
      const fallbackPayload = {
        messages: [
          { role: "system" as const, content: systemPrompt },
          { role: "system" as const, content: `Conversación completa del chat (analiza lo más relevante):\n${allMessages}` }
        ],
      };
      
      try {
        const response = await this.openai.chat.completions.create({
          messages: fallbackPayload.messages,
          model: "gpt-3.5-turbo",
          temperature: 0.4,
          max_tokens: 600,
        });

        let content = response.choices[0].message.content || "";
        if (!content || content.trim().length === 0) {
          return "He estado observando el chat, pero no hay mucho que contar por el momento. ¡Charlemos más! 💬";
        }
        
        console.log(`Resumen generado (modo fallback): ${content}`);
        return content;
      } catch (error) {
        console.error("Error generating fallback summary:", error);
        return "El chat ha estado tranquilo últimamente. ¡Vamos a animarlo con más conversaciones interesantes! 🚀";
      }
    }

    const messages = filteredMessages
      .map(({ user, message }: any) => `${user}: ${message}`)
      .join("\n");

    const payload = {
      messages: [
        { role: "system" as const, content: systemPrompt },
        { role: "system" as const, content: `Conversación filtrada del chat (${filteredMessages.length} mensajes relevantes):\n${messages}` }
      ],
    };

    try {
      const response = await this.openai.chat.completions.create({
        messages: payload.messages,
        model: "gpt-3.5-turbo",
        temperature: 0.3, // Lower temperature for more focused summaries
        max_tokens: 600, // Increased to allow for longer content that will be split
      });

      let content = response.choices[0].message.content || "";
      
      // Asegurar que el resumen no esté vacío
      if (!content || content.trim().length === 0) {
        console.log("⚠️ OpenAI devolvió contenido vacío para el resumen");
        return "He estado participando en conversaciones sobre anime, manga y manhwa con los usuarios del chat.";
      }

      console.log(`✅ Resumen generado exitosamente: ${content.length} caracteres`);
      return content;
    } catch (error) {
      console.error("❌ Error generating summary:", error);
      
      // Información adicional de debug
      console.log(`📊 Datos del intento de resumen:
        - Mensajes originales: ${recentMessages.length}
        - Mensajes filtrados: ${filteredMessages.length}
        - Longitud del prompt: ${JSON.stringify(payload).length} caracteres`);
        
      return "No se pudo generar el resumen debido a un error técnico.";
    }
  }

  // Función para filtrar mensajes y mejorar la calidad del resumen
  private filterMessagesForSummary(messages: any[]): any[] {
    const filtered: any[] = [];
    const seenMessages = new Set<string>();
    const botUsername = process.env.CBOX_USERNAME;
    
    for (const msg of messages) {
      const { user, message } = msg;
      const lowerMessage = message.toLowerCase().trim();
      
      // Saltar mensajes del bot (protección adicional)
      if (user === botUsername) {
        console.log(`🚫 Mensaje del bot excluido del resumen: ${user} - "${message.substring(0, 30)}..."`);
        continue;
      }
      
      // Saltar mensajes muy cortos (menos de 10 caracteres)
      if (lowerMessage.length < 10) continue;
      
      // Saltar mensajes repetitivos comunes
      const repetitivePatterns = [
        /^(hola|hi|hello|hey)$/i,
        /^bot$/i,
        /^@\w+\s*(hola|hi|hello|hey)?$/i,
        /^no hay respuesta disponible/i,
        /^lo siento.*no tengo información/i,
        /^¿hay algo.*en lo que pueda ayudarte/i,
        /^estoy aquí para.*ayudarte/i
      ];
      
      const isRepetitive = repetitivePatterns.some(pattern => pattern.test(lowerMessage));
      if (isRepetitive) continue;
      
      // Evitar duplicados exactos
      const messageKey = `${user}:${lowerMessage}`;
      if (seenMessages.has(messageKey)) continue;
      seenMessages.add(messageKey);
      
      // Priorizar mensajes con contenido valioso
      const valuableKeywords = [
        'anime', 'manga', 'manhwa', 'recomend', 'gusta', 'favorito',
        'visto', 'leído', 'rating', 'puntuación', 'género', 'isekai',
        'shounen', 'romance', 'fantasía', 'acción', 'slice of life',
        'misterio', 'horror', 'comedia', 'drama', 'aventura',
        'recuerda', 'memoria', 'información', 'sinopsis', 'historia',
        'personaje', 'protagonista', 'trama', 'teoría', 'explicar'
      ];
      
      const hasValuableContent = valuableKeywords.some(keyword => 
        lowerMessage.includes(keyword)
      );
      
      // Incluir mensajes con contenido valioso o conversaciones largas (>30 chars)
      if (hasValuableContent || lowerMessage.length > 30) {
        filtered.push(msg);
      }
    }
    
    return filtered;
  }

  // Función de debug para testear el filtrado de mensajes
  async debugMessageFiltering(): Promise<void> {
    console.log('🔍 Analizando calidad del log de mensajes...');
    
    const history = await getLastMessages();
    const recentMessages = history.slice(-50); // Solo los últimos 50 para debug
    const botUsername = process.env.CBOX_USERNAME;
    
    // Contar mensajes del bot
    const botMessages = recentMessages.filter((msg: any) => msg.user === botUsername);
    const userMessages = recentMessages.filter((msg: any) => msg.user !== botUsername);
    
    console.log(`📊 Estadísticas del log:
      - Total mensajes: ${history.length}
      - Mensajes recientes analizados: ${recentMessages.length}
      - Mensajes de usuarios: ${userMessages.length}
      - Mensajes del bot: ${botMessages.length} ${botMessages.length > 0 ? '⚠️ PROBLEMA!' : '✅'}`);
    
    if (botMessages.length > 0) {
      console.log('\n🚨 MENSAJES DEL BOT DETECTADOS EN EL LOG:');
      botMessages.slice(0, 3).forEach((msg: any, index: number) => {
        console.log(`  ${index + 1}. ${msg.user}: ${msg.message.substring(0, 60)}${msg.message.length > 60 ? '...' : ''}`);
      });
    }
    
    const filteredMessages = this.filterMessagesForSummary(recentMessages);
    
    console.log(`🔄 Resultado del filtrado:
      - Mensajes antes: ${recentMessages.length}
      - Mensajes después: ${filteredMessages.length}
      - Porcentaje útil: ${((filteredMessages.length / recentMessages.length) * 100).toFixed(1)}%`);
    
    // Mostrar algunos ejemplos de mensajes filtrados
    console.log('\n📝 Ejemplos de mensajes que PASARON el filtro:');
    filteredMessages.slice(0, 5).forEach((msg, index) => {
      console.log(`  ${index + 1}. ${msg.user}: ${msg.message.substring(0, 60)}${msg.message.length > 60 ? '...' : ''}`);
    });
    
    // Mostrar algunos ejemplos de mensajes eliminados
    const removedMessages = recentMessages.filter((msg: any) => 
      !filteredMessages.some((filtered: any) => 
        filtered.user === msg.user && filtered.message === msg.message
      )
    );
    
    console.log('\n🗑️ Ejemplos de mensajes que fueron ELIMINADOS:');
    removedMessages.slice(0, 5).forEach((msg: any, index: number) => {
      console.log(`  ${index + 1}. ${msg.user}: ${msg.message.substring(0, 60)}${msg.message.length > 60 ? '...' : ''}`);
    });
  }

  // Método para extraer memorias de la respuesta usando el nuevo formato
  private extractMemoryFromResponse(content: string, username?: string): {
    cleanContent: string;
    memoriesToSave: string[];
  } {
    const memoriesToSave: string[] = [];
    let cleanContent = content;

    // Verificar si el contenido tiene token de resumen ANTES del procesamiento
    const hasResumenToken = content.includes("{{resumen}}");

    // Buscar todas las instancias de SAVE_MEMORY()
    const memoryRegex = /SAVE_MEMORY\s*\(\s*["'`](.*?)["'`]\s*\)/gi;
    let match;

    while ((match = memoryRegex.exec(content)) !== null) {
      const memoryContent = match[1].trim();
      if (memoryContent && memoryContent.length > 0) {
        memoriesToSave.push(memoryContent);
      }
    }

    // Limpiar el contenido removiendo todas las llamadas SAVE_MEMORY
    cleanContent = content.replace(memoryRegex, '').trim();
    
    // Verificar si el token de resumen se perdió durante la limpieza y restaurarlo
    if (hasResumenToken && !cleanContent.includes("{{resumen}}")) {
      console.log("🔧 Restaurando token {{resumen}} perdido durante el procesamiento de memoria...");
      // Buscar una ubicación lógica para insertar el token
      if (cleanContent.includes("📋✨")) {
        cleanContent = cleanContent.replace("📋✨", "📋✨ {{resumen}}");
      } else if (cleanContent.includes("resumen del chat")) {
        cleanContent = cleanContent.replace("resumen del chat", "resumen del chat {{resumen}}");
      } else {
        // Como último recurso, agregarlo al final
        cleanContent += " {{resumen}}";
      }
    }
    
    // Limpiar líneas vacías extra que puedan quedar
    cleanContent = cleanContent.replace(/\n\s*\n\s*\n/g, '\n\n');

    return {
      cleanContent,
      memoriesToSave
    };
  }

  // Método mejorado para validar si una memoria vale la pena guardar
  private isMemoryWorthSaving(memory: string, username?: string): boolean {
    const lowerMemory = memory.toLowerCase();
    
    // Muy corta o genérica
    if (memory.length < 10) return false;
    
    // Frases genéricas que no aportan valor
    const genericPhrases = [
      'debo recordar',
      'es importante',
      'información general',
      'el usuario preguntó',
      'recuerda que',
      'generando resumen',
      'hola',
      'gracias',
      'de nada',
      'usuario dice',
      'conversación sobre'
    ];
    
    const isGeneric = genericPhrases.some(phrase => 
      lowerMemory.includes(phrase)
    );
    
    if (isGeneric) return false;
    
    // Información valiosa específica
    const valuableKeywords = [
      'le gusta',
      'favorito',
      'prefiere',
      'recomendación',
      'anime:',
      'manga:',
      'manhwa:',
      'interesado en',
      'género',
      'su anime',
      'su manga',
      'vio',
      'leyó',
      'está viendo',
      'está leyendo',
      'rating',
      'puntuación',
      'odia',
      'no le gusta'
    ];
    
    const hasValue = valuableKeywords.some(keyword => 
      lowerMemory.includes(keyword)
    );
    
    // Información específica del usuario (si se proporciona username)
    if (username) {
      const userSpecific = [
        username.toLowerCase(),
        'su nombre',
        'se llama',
        'edad',
        'años',
        'país',
        'ciudad'
      ];
      
      const isUserSpecific = userSpecific.some(keyword => 
        lowerMemory.includes(keyword)
      );
      
      if (isUserSpecific) return true;
    }
    
    return hasValue;
  }

  // Método para generar ejemplos de uso de memoria en el prompt
  private generateMemoryExamples(username?: string): string {
    if (!Boolean(process.env.USE_MEMORY)) return '';
    
    return `

EJEMPLOS de uso correcto de SAVE_MEMORY:
- Usuario dice que le gusta el shounen → SAVE_MEMORY("Le gusta el género shounen")
- Usuario menciona que vio Naruto → SAVE_MEMORY("Ha visto Naruto completo")
- Usuario pide recomendación de romance → SAVE_MEMORY("Interesado en anime de romance")
- Usuario dice que no le gusta el gore → SAVE_MEMORY("No le gusta el contenido gore")

NO uses SAVE_MEMORY para:
- Información ya conocida del bot
- Respuestas genéricas
- Saludos o despedidas
- Información que no es específica del usuario`;
  }

  // Método de debug para probar el sistema de memoria
  async testMemorySystem(testResponses: string[]): Promise<void> {
    console.log('🧪 Probando sistema de memoria refactorizado...');
    
    for (let i = 0; i < testResponses.length; i++) {
      const response = testResponses[i];
      console.log(`\n--- Prueba ${i + 1} ---`);
      console.log(`Respuesta original: ${response}`);
      
      const results = this.extractMemoryFromResponse(response, 'TestUser');
      console.log(`Contenido limpio: ${results.cleanContent}`);
      console.log(`Memorias a guardar: ${JSON.stringify(results.memoriesToSave)}`);
      
      results.memoriesToSave.forEach((memory, index) => {
        const isValid = this.isMemoryWorthSaving(memory, 'TestUser');
        console.log(`  Memoria ${index + 1}: "${memory}" - ${isValid ? '✅ Válida' : '❌ Rechazada'}`);
      });
    }
  }

  // Función para verificar configuración del sistema
  static verifyConfiguration(): void {
    const maxTokens = parseInt(process.env.MAX_LENGTH_RESPONSE || "500");
    
    console.log("🔧 Verificando configuración del bot...");
    console.log(`📊 MAX_LENGTH_RESPONSE: ${maxTokens} tokens`);
    
    if (maxTokens < 250) {
      console.log("⚠️ ADVERTENCIA: MAX_LENGTH_RESPONSE muy bajo para resúmenes");
      console.log("   Recomendado: mínimo 300 tokens para funcionalidad completa");
    }
    
    if (!process.env.OPENAI_API_KEY) {
      console.log("❌ ERROR: OPENAI_API_KEY no configurada");
    }
    
    console.log("✅ Verificación de configuración completada");
  }
}
