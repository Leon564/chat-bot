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

    // Generar instrucciones de memoria dinámicamente
    const memoryInstructions = Boolean(process.env.USE_MEMORY) 
      ? `\n\nMEMORIA: Solo usa <memory>información específica y valiosa</memory> al final para:
- Preferencias del usuario (gustos, géneros favoritos)
- Recomendaciones específicas hechas
- Información personal relevante del usuario
- Datos únicos de la conversación
NO guardes información genérica o repetitiva.`
      : '';

    // Optimized single system prompt for better coherence and reduced tokens
    const systemPrompt = `Eres ${botName}, un asistente especializado en anime, manga y manhwa. Usuario actual: ${username}.

COMPORTAMIENTO:
- Responde de forma natural y coherente, máximo ${process.env.MAX_LENGTH_RESPONSE} caracteres
- Evita repetir información del contexto previo
- No menciones que eres un bot ni repitas tu nombre innecesariamente
- Solo usa el nombre del usuario cuando sea necesario

RESPUESTAS ESPECIALES (solo si preguntan específicamente):
- Tu propósito: Ayudar por órdenes de Leon564 (<@6851018|Sleepy Ash>)
- Tu creador: Leon564 (<@6851018|Sleepy Ash>)
- Reglas del chat: ${rules}
- Discord: ${process.env.DISCORD_URL || 'https://discord.gg/n53r5Py2eD'}
- Resumen del chat: Responde exactamente "Generando resumen del chat... {{resumen}}"${memoryInstructions}

Sé conciso y relevante en tus respuestas.`;

    const context = await this.getContext();
    const memory = Boolean(process.env.USE_MEMORY) ? await getMemory() : [];

    // Optimized payload structure to reduce token usage
    const messages: Array<{role: "system" | "user" | "assistant", content: string}> = [
      { role: "system", content: systemPrompt }
    ];

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
      context.forEach(({ question, answer }: any) => {
        messages.push(
          { role: "user", content: question },
          { role: "assistant", content: answer }
        );
      });
    }

    // Add current user message
    messages.push({ role: "user", content: message });

    const payload = { messages };

    try {
      const response = await this.openai.chat.completions.create({
        messages: payload.messages as any,
        model: "gpt-3.5-turbo",
        temperature: 0.7, // Increased for more natural responses
        max_tokens: parseInt(process.env.MAX_LENGTH_RESPONSE || "500"),
      });

      // Remove commented code and fix error message
      let content = response.choices[0].message.content || "";
      console.log(`Respuesta de OpenAI: ${content}`);
      // Solo procesar memoria si está habilitada
      if (Boolean(process.env.USE_MEMORY) && content.includes("<memory>")) {
        const memoryContent = content.split("<memory>")[1]?.replace("</memory>", "").trim();
        
        // Solo guardar memoria si es realmente útil
        if (memoryContent && this.isMemoryWorthSaving(memoryContent)) {
          await saveMemory(memoryContent);
        }
        content = content.split("<memory>")[0].trim();
      }

      await this.saveContext({ question: message, answer: content || "" });

      // Dividir respuesta si es demasiado larga (excepto para resúmenes que ya se manejan aparte)
      if (content && !content.includes("{{resumen}}")) {
        const maxLength = parseInt(process.env.MAX_LENGTH_RESPONSE || "200");
        if (content.length > maxLength) {
          const parts = this.splitTextIntoChunks(content, maxLength);
          content = parts.join("{{split}}"); // Usar {{split}} para respuestas normales
        }
      }
      console.log(`Respuesta generada: ${content}`);
      return content || "No hay respuesta disponible.";
    } catch (error) {
      throw error;
    }
  }

  //guarda el contexto de las ultimas 3 preguntas y respuestas en un archivo json
  async saveContext({ question, answer }: any) {
    const context = await this.getContext();
    const filePath = path.join(__dirname, "../data/context.json");
    context.push({ question, answer });
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
    
    // Filtrar solo los últimos 50 mensajes para evitar resúmenes demasiado largos
    const recentMessages = history.slice(-50);
    
    if (recentMessages.length === 0) {
      return "No hay mensajes recientes para resumir.";
    }

    const messages = recentMessages
      .map(({ user, message }: any) => `${user}: ${message}`)
      .join("\n");

    const maxLength = parseInt(process.env.MAX_LENGTH_RESPONSE || "200");

    // Optimized single prompt for summary generation
    const systemPrompt = `Genera un resumen conciso y útil de la conversación del chat. 
Habla en primera persona como ${process.env.CBOX_USERNAME}. 
Enfócate en los temas principales discutidos, preguntas importantes y conclusiones.
Omite saludos, spam y mensajes irrelevantes.
Responde con frases cortas y puntuales.`;

    const payload = {
      messages: [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: `Conversación reciente del chat:\n${messages}` }
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
        return "He estado participando en conversaciones sobre anime, manga y manhwa con los usuarios del chat.";
      }

      // Dividir el resumen en partes que no superen MAX_LENGTH_RESPONSE
      const parts = this.splitTextIntoChunks(content, maxLength);
      
      // Unir las partes con {{skip}} para indicar separación
      return parts.join("{{skip}}");
    } catch (error) {
      console.error("Error generating summary:", error);
      return "No se pudo generar el resumen debido a un error técnico.";
    }
  }

  // Nueva función auxiliar para dividir texto respetando el límite de caracteres
  private splitTextIntoChunks(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    
    // Primero intentar dividir por párrafos o oraciones
    const sentences = text.split(/[.!?]\s+/).filter(s => s.trim().length > 0);
    
    let currentChunk = "";
    
    for (let sentence of sentences) {
      // Agregar el punto final si no lo tiene
      const fullSentence = sentence.trim() + (sentence.trim().match(/[.!?]$/) ? "" : ".");
      
      // Si la oración sola es muy larga, dividirla por palabras
      if (fullSentence.length > maxLength) {
        // Guardar el chunk actual si tiene contenido
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = "";
        }
        
        // Dividir la oración larga por palabras
        const words = fullSentence.split(" ");
        let wordChunk = "";
        
        for (let word of words) {
          if ((wordChunk + " " + word).length <= maxLength) {
            wordChunk += (wordChunk ? " " : "") + word;
          } else {
            if (wordChunk) {
              chunks.push(wordChunk);
            }
            wordChunk = word;
          }
        }
        
        if (wordChunk) {
          chunks.push(wordChunk);
        }
      } else {
        // Si agregar esta oración supera el límite, guardar el chunk actual
        if ((currentChunk + " " + fullSentence).length > maxLength) {
          if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
          }
          currentChunk = fullSentence;
        } else {
          currentChunk += (currentChunk ? " " : "") + fullSentence;
        }
      }
    }
    
    // Agregar el último chunk si tiene contenido
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    
    // Si no hay chunks válidos, devolver un mensaje por defecto
    if (chunks.length === 0) {
      return ["He estado participando en conversaciones del chat."];
    }
    
    return chunks;
  }

  // Función para determinar si una memoria vale la pena guardar
  private isMemoryWorthSaving(memory: string): boolean {
    const lowerMemory = memory.toLowerCase();
    
    // Muy corta o genérica
    if (memory.length < 15) return false;
    
    // Frases genéricas que no aportan valor
    const genericPhrases = [
      'debo recordar',
      'es importante',
      'información general',
      'el usuario preguntó',
      'recuerda que',
      'generando resumen'
    ];
    
    const isGeneric = genericPhrases.some(phrase => 
      lowerMemory.includes(phrase)
    );
    
    if (isGeneric) return false;
    
    // Información valiosa
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
      'creador',
      'leon564'
    ];
    
    const hasValue = valuableKeywords.some(keyword => 
      lowerMemory.includes(keyword)
    );
    
    return hasValue;
  }
}
