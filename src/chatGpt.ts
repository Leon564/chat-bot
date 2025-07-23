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
- Discord: https://discord.gg/n53r5Py2eD
- Resumen: "Generando resumen del chat... {{resumen}}"

MEMORIA: Si algo es importante para recordar, úsalo al final: <memory>información importante</memory>

Sé conciso y relevante en tus respuestas.`;

    const context = await this.getContext();
    const memory = await getMemory();

    // Optimized payload structure to reduce token usage
    const messages: Array<{role: "system" | "user" | "assistant", content: string}> = [
      { role: "system", content: systemPrompt }
    ];

    // Add memory context if available
    if (memory && memory.length > 0) {
      messages.push({
        role: "system", 
        content: `Memoria importante: ${memory.slice(-3).join('; ')}`
      });
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

    console.log(payload);

    try {
      const response = await this.openai.chat.completions.create({
        messages: payload.messages as any,
        model: "gpt-3.5-turbo",
        temperature: 0.7, // Increased for more natural responses
        max_tokens: parseInt(process.env.MAX_LENGTH_RESPONSE || "500"),
      });

      // Remove commented code and fix error message
      let content = response.choices[0].message.content || "";

      if (content.includes("<memory>")) {
        if (Boolean(process.env.USE_MEMORY)) {
          await saveMemory(
            content.split("<memory>")[1]?.replace("</memory>", "").trim()
          );
        }
        content = content.split("<memory>")[0].trim();
      }

      await this.saveContext({ question: message, answer: content || "" });

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
    const messages = history
      .map(({ user, message }: any) => `${user}: ${message}`)
      .join("\n");

    // Optimized single prompt for summary generation
    const systemPrompt = `Genera un resumen conciso del chat. Habla en primera persona como ${process.env.CBOX_USERNAME}. 
Omite la solicitud de resumen actual. Resume las conversaciones principales sin repetir el contenido exacto.`;

    const payload = {
      messages: [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: `Historial del chat:\n${messages}` }
      ],
    };

    try {
      const response = await this.openai.chat.completions.create({
        messages: payload.messages,
        model: "gpt-3.5-turbo",
        temperature: 0.3, // Lower temperature for more focused summaries
        max_tokens: 300, // Limit summary length
      });

      const content = response.choices[0].message.content || "";
      return content || "No se pudo generar el resumen.";
    } catch (error) {
      throw error;
    }
  }
}
