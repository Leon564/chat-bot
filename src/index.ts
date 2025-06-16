import "dotenv/config";
import WebSocket from "ws";
import { login } from "./login";
import { Gpt } from "./chatGpt";
import { boxDetails } from "./boxDetails";
import { sendMessage, toDomain } from "./messages";
import { isLastEvent, saveEventsLog, saveLog } from "./utils";

class Bot {
  private responseQueue: any[] = [];
  private lastSentTime: number = Date.now() - 20500;

  constructor(
    private uname: string,
    private ukey: string,
    private pic: string,
    private gpt: Gpt = new Gpt(),
    private socket: WebSocket,
    private boxId: string,
    private boxTag: string,
    private iframeUrl: string
  ) {
    setInterval(() => {
      if (
        this.responseQueue.length > 0 &&
        Date.now() - this.lastSentTime > 20500
      ) {
        const response = this.responseQueue.shift();
        sendMessage(response);
        this.lastSentTime = Date.now();
      }
    }, 1000);
  }

  public static async start() {
    const { boxId, boxTag, iframeUrl, socketUrl } = await boxDetails(
      process.env.CBOX_URL!
    );
    const dataLogin = await login({
      boxId: boxId!,
      boxTag: boxTag!,
      iframeUrl: iframeUrl!,
      password: process.env.CBOX_PASSWORD!,
      username: process.env.CBOX_USERNAME!,
    });
    if (dataLogin.error) {
      console.log("error al iniciar sesion");
      console.log(dataLogin.error);
      return;
    }
    const { nme, key, pic } = dataLogin.udata;

    console.log(`starting bot as ${nme}`);

    new Bot(
      nme || process.env.CBOX_USERNAME!,
      key!,
      process.env.CBOX_DEFAULT_PIC || pic || "",
      new Gpt(),
      new WebSocket(socketUrl!),
      boxId!,
      boxTag!,
      iframeUrl!
    ).handleEvents();
  }

  async handleEvents() {
    this.socket.on("open", () => {
      console.log("Conexión abierta");
    });

    // Manejar los mensajes recibidos del servidor
    this.socket.on("message", async (data: WebSocket.Data) => {
      const { date, id, lvl, message, name } = toDomain(data);

      await saveLog(name, message);

      if (
        !message ||
        name === this.uname ||
        (!message.toLowerCase().includes("bot") &&
          !message.toLowerCase().includes(this.uname.toLowerCase()))
      )
        return;

      console.log(`Mensaje recibido: ${message} de ${name} el ${date}`);

      const _textColor = process.env.TEXT_COLOR;

      const textColor = _textColor ? `^#${_textColor} ` : "";

      const response = await this.gpt.chat(message, this.uname);

      if (!response) return;

      const responseData = {
        key: this.ukey,
        message: `${textColor}<@${name}> ${response.replace("{{resumen}}", '')}`,
        pic: this.pic,
        username: this.uname,
        boxTag: this.boxTag,
        boxId: this.boxId,
        iframeUrl: this.iframeUrl,
      };

      if (Date.now() - this.lastSentTime < 20500) {
        this.responseQueue.push(responseData);
        return;
      }
      
      if (response.includes("{{resumen}}") && !(await isLastEvent("Resumen"))) {
        const responseData = {
          key: this.ukey,
          message: `${textColor}<@${name}> Puedes leer el resumen anterior y esperar 10 minutos para poder generar uno nuevo. 🙂`,
          pic: this.pic,
          username: this.uname,
          boxTag: this.boxTag,
          boxId: this.boxId,
          iframeUrl: this.iframeUrl,
        };
        sendMessage(responseData);
        return;
      }

      sendMessage(responseData);

      if (response.includes("{{resumen}}")) {
        const resumen = await this.gpt.generateSummary();
        const responses = resumen.split("{{skip}}");
        //envia el resumen con un delay de 1 segundo entre cada parte
        for (let i = 0; i < responses.length; i++) {
          const responseData = {
            key: this.ukey,
            message: `${textColor} ${responses[i]
              .replace("{{resumen}}", "")
              .replace("{{skip}}", "")
              .trim()}`,
            pic: this.pic,
            username: this.uname,
            boxTag: this.boxTag,
            boxId: this.boxId,
            iframeUrl: this.iframeUrl,
          };
          setTimeout(() => {
            sendMessage(responseData);
          }, 1000 * i);
        }
        saveEventsLog("Resumen", name);
      }

      this.lastSentTime = Date.now();
    });
    // Manejar errores en la conexión
    this.socket.on("error", (error: Error) => {
      console.error("Error de conexión:", error.message);
      Bot.start();
    });

    // Manejar el cierre de la conexión
    this.socket.on("close", (code: number, reason: string) => {
      console.log("Conexión cerrada:", code.toString(), reason);
      Bot.start();
    });
  }
}

Bot.start();
