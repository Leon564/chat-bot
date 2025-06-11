import "dotenv/config";

export class Gpt {
  constructor(
    private readonly apiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
  ) {}

  async chat(message: string, botName?: string) {
    const url = `${this.apiUrl}?key=${process.env.GEMINI_API_KEY}`;

    const systemPrompt = [
      `si te preguntan te llamas ${botName}.`,
      "sabes todo sobre anime.",
      "responde con un maximo de 200 caracteres.",
      "responde de la manera mas puntual y corta posible.",
    ].join(" ");

    const payload = {
      contents: [
        {
          parts: [{ text: `gemini:[${systemPrompt}]\n\nuser:${message}` }],
        },
      ],
    };
    console.log(JSON.stringify(payload));
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
