import "dotenv/config";
import WebSocket from "ws";
import { login } from "./login";
import { Gpt } from "./chatGpt";
import { boxDetails } from "./boxDetails";
import { sendMessage, toDomain } from "./messages";
import {
  clearMessagesLog,
  getLastEventType,
  saveEventsLog,
  saveLog,
  sleep,
  cleanExistingMemories,
} from "./utils";

class Bot {
  private responseQueue: any[] = [];
  private lastSentTime: number =
    Date.now() - Number(process.env.RESPONSE_DELAY || 20500);

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
        Date.now() - this.lastSentTime >
          Number(process.env.RESPONSE_DELAY || 20500)
      ) {
        const response = this.responseQueue.shift();
        sendMessage(response);
        this.lastSentTime = Date.now();
        
        // Si hay más respuestas en la cola del mismo tipo (partes múltiples), 
        // procesarlas con un delay menor
        if (this.responseQueue.length > 0) {
          setTimeout(() => {
            const nextResponse = this.responseQueue.shift();
            if (nextResponse) {
              sendMessage(nextResponse);
            }
          }, Number(process.env.RESPONSE_DELAY || 1000)); // Usar RESPONSE_DELAY para partes adicionales
        }
      }
    }, 1000);
  }

  public static async start() {
    // Limpiar memorias duplicadas al iniciar solo si la memoria está habilitada
    if (Boolean(process.env.USE_MEMORY)) {
      await cleanExistingMemories();
    }
    
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
    console.log(`Memory system: ${Boolean(process.env.USE_MEMORY) ? 'ENABLED' : 'DISABLED'}`);

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

      if (name && message) {
        await saveLog(name, message);
      }

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

      const response = await this.gpt.chat(message, this.uname, name);

      if (!response) return;

      // Verificar si la respuesta necesita ser dividida
      const isMultiPart = response.includes("{{split}}");
      const parts = isMultiPart ? response.split("{{split}}").filter(part => part.trim()) : [response];

      const responseData = {
        key: this.ukey,
        message: `${textColor}<@${name}> ${parts[0].replace("{{resumen}}", "")}`,
        pic: this.pic,
        username: this.uname,
        boxTag: this.boxTag,
        boxId: this.boxId,
        iframeUrl: this.iframeUrl,
      };

      if (
        Date.now() - this.lastSentTime <
        Number(process.env.RESPONSE_DELAY || 20500)
      ) {
        // Si hay múltiples partes, agregar todas a la cola
        if (isMultiPart) {
          parts.forEach((part, index) => {
            const partData = {
              key: this.ukey,
              message: index === 0 
                ? `${textColor}<@${name}> ${part.replace("{{resumen}}", "")}` 
                : `${textColor}${part}`,
              pic: this.pic,
              username: this.uname,
              boxTag: this.boxTag,
              boxId: this.boxId,
              iframeUrl: this.iframeUrl,
            };
            this.responseQueue.push(partData);
          });
        } else {
          this.responseQueue.push(responseData);
        }
        return;
      }

      const lastResumenEvent = await getLastEventType("Resumen");

      // Verificar si se solicitó resumen y si ha pasado suficiente tiempo
      if (response.includes("{{resumen}}")) {
        if (lastResumenEvent.minutesLeft < 10) {
          const responseData = {
            key: this.ukey,
            message: `${textColor}<@${name}> Puedes leer el resumen anterior y esperar 10 minutos para poder generar uno nuevo. 🙂`,
            pic: this.pic,
            username: this.uname,
            boxTag: this.boxTag,
            boxId: this.boxId,
            iframeUrl: this.iframeUrl,
          };
          await sendMessage(responseData);
          this.lastSentTime = Date.now();
          return;
        }

        // Enviar mensaje de confirmación primero
        const confirmationData = {
          key: this.ukey,
          message: `${textColor}<@${name}> ${response.replace("{{resumen}}", "")}`,
          pic: this.pic,
          username: this.uname,
          boxTag: this.boxTag,
          boxId: this.boxId,
          iframeUrl: this.iframeUrl,
        };
        await sendMessage(confirmationData);
        this.lastSentTime = Date.now();

        // Generar y enviar el resumen
        try {
          const resumen = await this.gpt.generateSummary();
          const responses = resumen.split("{{skip}}").filter(part => part.trim());
          
          console.log(`Enviando resumen en ${responses.length} parte(s)`);
          
          // Enviar el resumen con un delay entre cada parte
          for (let i = 0; i < responses.length; i++) {
            const part = responses[i].trim();
            if (part && part !== "{{skip}}" && part !== "{{resumen}}") {
              const partNumber = responses.length > 1 ? ` (${i + 1}/${responses.length})` : "";
              const responseData = {
                key: this.ukey,
                message: `${textColor}📋${partNumber} ${part}`,
                pic: this.pic,
                username: this.uname,
                boxTag: this.boxTag,
                boxId: this.boxId,
                iframeUrl: this.iframeUrl,
              };

              await sendMessage(responseData);
              
              // Solo esperar entre partes si hay más de una
              if (i < responses.length - 1) {
                await sleep(Number(process.env.RESPONSE_DELAY || 1000)); // Usar RESPONSE_DELAY entre partes del resumen
              }
            }
          }
          
          // Guardar evento de resumen y limpiar log
          await saveEventsLog("Resumen", name);
          await clearMessagesLog();
        } catch (error) {
          console.error("Error generating summary:", error);
          const errorData = {
            key: this.ukey,
            message: `${textColor}❌ Error al generar el resumen. Inténtalo más tarde.`,
            pic: this.pic,
            username: this.uname,
            boxTag: this.boxTag,
            boxId: this.boxId,
            iframeUrl: this.iframeUrl,
          };
          await sendMessage(errorData);
        }
        return;
      }

      // Enviar respuesta normal si no es resumen
      if (isMultiPart) {
        // Enviar la primera parte inmediatamente
        await sendMessage(responseData);
        this.lastSentTime = Date.now();
        
        // Enviar las partes restantes con delay
        for (let i = 1; i < parts.length; i++) {
          const partData = {
            key: this.ukey,
            message: `${textColor}${parts[i]}`,
            pic: this.pic,
            username: this.uname,
            boxTag: this.boxTag,
            boxId: this.boxId,
            iframeUrl: this.iframeUrl,
          };
          
          await sleep(Number(process.env.RESPONSE_DELAY || 1000)); // Usar RESPONSE_DELAY entre partes de respuesta normal
          await sendMessage(partData);
        }
      } else {
        await sendMessage(responseData);
        this.lastSentTime = Date.now();
      }
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
