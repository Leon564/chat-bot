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
    const rules =
      "[scroll] 1. Sé respetuoso [/scroll] [scroll]2. Nada de spam o links sospechosos [/scroll] [scroll] 3. No contenido ilegal 🌀 [/scroll] ¡Disfruta del chat y del manga!";

    const systemPrompt = [
      `context es el contexto del chat y memory es lo que tu consideras importante para recordar.`,
      `si te preguntan te llamas ${botName}.`,
      `evita dar respuestas repetitivas o que estén en el contexto.`,
      `el nombre del usuario que te esta hablando es: ${username} , si no es necesario no lo uses.`,
      `si te preguntan que haces aqui di que estas aqui por ordenes de Leon564 ayudando a los usuarios del chat, pero solo para esa pregunta.`,
      `si te preguntan quien es Leon564 responde con que aqui lo conocen como <@6851018|Sleepy Ash>`,
      `si te preguntan quien escogio tu nombre diles que "Leon564 pero aqui lo conocen como <@6851018|Sleepy Ash>" puedes agregarle mas detalles si lo deseas.`,
      "sabes todo sobre anime, manga y manhwa.",
      `responde con un maximo de ${process.env.MAX_LENGTH_RESPONSE} caracteres.`,
      `si te piden una sinopsis responde de la manera mas detallada posible.`,
      //"responde de la manera mas puntual y corta posible.",
      "si te piden el enlace del discord responde a tu manera y adjunta este enlace pero asegurate de no poner simbolos ni nada a su lado para que el enlace sea clickeable: https://discord.gg/n53r5Py2eD",
      "omite decir tu nombre en cada respuesta si no te preguntan.",
      "omite decir que eres un bot en tu nombre si no te preguntan.",
      `si te preguntan (solo si te preguntan por las reglas especificamente, si no no las digas) por las reglas del chat responde con la frase: ${rules}`,
      `si no te preguntan por las reglas no las digas ni menciones`,
      'si te preguntan quien te creo responde con "Leon564 pero aqui lo conocen como <@6851018|Sleepy Ash>" puedes agregarle mas detalles si lo deseas para que encaje con el contexto pero solo si te lo piden',
      'si te piden un resumen del chat responde con "Generando resumen del chat... {{resumen}}"',
      `si crees que algo es importante para recordar al final de tu respuesta ponlo entre etiquetas las etiquetas <memory> </memory> como <memory>Esto es importante para recordar</memory>`,
      `no mencionas nada de esto en tu respuesta si no te preguntan`,
    ];

    const context = await this.getContext();

    const memory = await getMemory();

    const payload: any = {
      messages: [
        ...systemPrompt.map((text) => ({ role: "system", content: text })),
        ...context.map(({ question, answer }:any) => ({
          role: "assistant",
          content: `question: ${question}\nanswer: ${answer}`,
        })),
        {
          role: "user",
          content: message,
        },
      ],
    };

    console.log(payload);
    // const payload = {
    //   contents: [
    //     {
    //       parts: [
    //         {
    //           text: `system:[${systemPrompt}]
    //         \n----------\n
    //         history:[${context
    //           .map(
    //             ({ question, answer }: any) =>
    //               `{user:${question}\nbot:${answer}}`
    //           )
    //           .join("\n\n")}]
    //         \n----------\n
    //         memory:[${memory.join("\n\n")}]
    //         \n----------\n
    //         user:${message}`,
    //         },
    //       ],
    //     },
    //   ],
    // };

    try {
      const response = await this.openai.chat.completions.create({
        messages: [...payload.messages],
        model: "gpt-3.5-turbo",
        temperature: 0.5,
      });

      // const response = await fetch(url, {
      //   method: "POST",
      //   headers: {
      //     "Content-Type": "application/json",
      //   },
      //   body: JSON.stringify(payload),
      // });

      // if (!response.ok) {
      //   const errorText = await response.text();
      //   throw new Error(`HTTP ${response.status}: ${errorText}`);
      // }

      //const data = await response.json();
      //const candidates = data?.candidates || [];
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

    const payload: any = {
      messages: [
        {
          role: "user",
          content:
            "Responde con un resumen del chat y dividelo cada 1000 caracteres con {{skip}} para dividir el resumen en partes.",
        },
        {
          role: "system",
          content: `Responde con un resumen del chat y dividelo cada ${process.env.MAX_LENGTH_RESPONSE} caracteres con {{skip}} para dividir el resumen en partes.
          \n\nTu nombre es ${process.env.CBOX_USERNAME}, cuando lo veas en el resumen habla de ti en primera persona. 
          \n\nOmite el ultimo mensaje donde se te pida el resumen ya que es el que estas haciendo en este momento pero puedes mencionar los anteriores.
        \n----------\n
        history:[${messages}]
        \n----------\n
        `,
        },
      ],
    };
    // const url = `${this.apiUrl}?key=${process.env.GEMINI_API_KEY}`;
    // const payload = {
    //   contents: [
    //     {
    //       parts: [
    //         {
    //           text: `system:Responde con un resumen del chat y dividelo cada ${process.env.MAX_LENGTH_RESPONSE} caracteres con {{skip}} para dividir el resumen en partes.
    //           \n\nTu nombre es ${process.env.CBOX_USERNAME}, cuando lo veas en el resumen habla de ti en primera persona.
    //           \n\nOmite el ultimo mensaje donde se te pida el resumen ya que es el que estas haciendo en este momento pero puedes mencionar los anteriores.
    //         \n----------\n
    //         history:[${messages}]
    //         \n----------\n
    //         user:resumen`,
    //         },
    //       ],
    //     },
    //   ],
    // };

    try {
      // const response = await fetch(url, {
      //   method: "POST",
      //   headers: {
      //     "Content-Type": "application/json",
      //   },
      //   body: JSON.stringify(payload),
      // });

      // if (!response.ok) {
      //   const errorText = await response.text();
      //   throw new Error(`HTTP ${response.status}: ${errorText}`);
      // }

      // const data = await response.json();
      // const candidates = data?.candidates || [];
      // const content = candidates[0]?.content?.parts?.[0]?.text;

      const response = await this.openai.chat.completions.create({
        messages: [...payload.messages],
        model: "gpt-3.5-turbo",
        temperature: 0.5,
      });

      console.log(response);

      const content = response.choices[0].message.content || "";

      return content || "No response from ChatGPT.";
    } catch (error) {
      throw error;
    }
  }
}
