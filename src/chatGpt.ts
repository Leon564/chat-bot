import "dotenv/config";
import path from "path";
import fs from "fs";
import { getLastMessages, getMemory, saveMemory } from "./utils";

export class Gpt {
  constructor(
    private readonly apiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
  ) {}

  async chat(message: string, botName?: string) {
    const url = `${this.apiUrl}?key=${process.env.GEMINI_API_KEY}`;

    const rules =
      "[scroll] 1. Sé respetuoso [/scroll] [scroll]2. Nada de spam o links sospechosos [/scroll] [scroll] 3. No contenido ilegal 🌀 [/scroll] ¡Disfruta del chat y del manga!";

    const systemPrompt = [
      `context es el contexto del chat y memory es lo que tu consideras importante para recordar.`,
      `si te preguntan te llamas ${botName}.`,
      `si te preguntan que haces aqui di que estas aqui por ordenes de Leon564 ayudando a los usuarios del chat.`,
      `si te preguntan quien es Leon564 responde con que aqui lo conocen como <@6851018|Sleepy Ash>`,
      `si te preguntan quien escogio tu nombre diles que "Leon564 pero aqui lo conocen como <@6851018|Sleepy Ash>" puedes agregarle mas detalles si lo deseas.`,
      "sabes todo sobre anime, manga y manhwa.",
      `responde con un maximo de ${process.env.MAX_LENGTH_RESPONSE} caracteres.`,
      "responde de la manera mas puntual y corta posible.",
      "omite decir tu nombre en cada respuesta si no te preguntan.",
      "omite decir que eres un bot en tu nombre si no te preguntan.",
      `si te preguntan por las reglas del chat responde con la frase: ${rules}`,
      'si te preguntan quien te creo responde con "Leon564 pero aqui lo conocen como <@6851018|Sleepy Ash>" puedes agregarle mas detalles si lo deseas para que encaje con el contexto.',
      'si te piden un resumen del chat responde con "Generando resumen del chat... {{resumen}}"',
      `si crees que algo es importante para recordar al final de tu respuesta ponlo entre etiquetas las etiquetas <memory> </memory>`,
    ].join(" ");

    const context = await this.getContext();

    const memory = await getMemory();

    const payload = {
      contents: [
        {
          parts: [
            {
              text: `system:[${systemPrompt}]
            \n----------\n
            history:[${context
              .map(({ question, answer }: any) => `user:${question}\n${answer}`)
              .join("\n\n")}]
            \n----------\n
            memory:[${memory.join("\n\n")}]
            \n----------\n
            user:${message}`,
            },
          ],
        },
      ],
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      const candidates = data?.candidates || [];
      let content = candidates[0]?.content?.parts?.[0]?.text;

      if (content.includes("<memory>")) {
        await saveMemory(content.split("<memory>")[1]?.replace('</memory>', "").trim());
        content = content.split("<memory>")[0].trim();
      }

      await this.saveContext({ question: message, answer: content || "" });

      // if (content.includes("{{resumen}}")) {
      //   this.generateSummary();
      // }

      return (
        content /*.replace("{{resumen}}", "")*/ || "No response from Gemini."
      );
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
      .map(({ user, message }: any) => `${user}:${message}`)
      .join("\n\n");
    const url = `${this.apiUrl}?key=${process.env.GEMINI_API_KEY}`;
    const payload = {
      contents: [
        {
          parts: [
            {
              text: `system:Responde con un resumen del chat y dividelo cada ${process.env.MAX_LENGTH_RESPONSE} caracteres con {{skip}} para dividir el resumen en partes.
              \n\nTu nombre es ${process.env.CBOX_USERNAME}, cuando lo veas en el resumen habla de ti en primera persona. 
              \n\nOmite el ultimo mensaje donde se te pida el resumen ya que es el que estas haciendo en este momento pero puedes mencionar los anteriores.
            \n----------\n
            history:[${messages}]
            \n----------\n
            user:resumen`,
            },
          ],
        },
      ],
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      const candidates = data?.candidates || [];
      const content = candidates[0]?.content?.parts?.[0]?.text;

      return content || "No response from Gemini.";
    } catch (error) {
      throw error;
    }
  }
}
