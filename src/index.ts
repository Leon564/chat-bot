import "dotenv/config";
import WebSocket from "ws";
import { login } from "./login";
import { Gpt } from "./chatGpt";
import { boxDetails } from "./boxDetails";
import { sendMessage, toDomain } from "./messages";
import { MusicService } from "./musicService";
import {
  clearMessagesLog,
  getLastEventType,
  getLastMessages,
  saveEventsLog,
  saveLog,
  sleep,
  cleanExistingMemories,
  migrateMemoriesToUserFormat,
  splitMessageIntoParts,
  cleanBotMessagesFromLog,
} from "./utils";

class Bot {
  private responseQueue: any[] = [];
  private lastSentTime: number =
    Date.now() - Number(process.env.RESPONSE_DELAY || 20500);
  private lastLoginTime: number = Date.now();
  private readonly SESSION_DURATION = 60 * 60 * 1000; // 1 hora en milisegundos

  constructor(
    private uname: string,
    private ukey: string,
    private pic: string,
    private gpt: Gpt = new Gpt(),
    private musicService: MusicService = new MusicService(),
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
        this.sendMessageWithSessionCheck(response);
        
        // Si hay más respuestas en la cola del mismo tipo (partes múltiples), 
        // procesarlas con un delay menor
        if (this.responseQueue.length > 0) {
          setTimeout(async () => {
            const nextResponse = this.responseQueue.shift();
            if (nextResponse) {
              await this.sendMessageWithSessionCheck(nextResponse);
            }
          }, Number(process.env.RESPONSE_DELAY || 1000)); // Usar RESPONSE_DELAY para partes adicionales
        }
      }
    }, 1000);
  }

  public static async start() {
    // Verificar configuración del sistema
    //Gpt.verifyConfiguration();
    
    // Migrar memorias al nuevo formato al iniciar si es necesario
    if (Boolean(process.env.USE_MEMORY)) {
      await migrateMemoriesToUserFormat();
      await cleanExistingMemories();
    }
    
    // Limpiar mensajes del bot del log existente
    const botUsername = process.env.CBOX_USERNAME!;
    await cleanBotMessagesFromLog(botUsername);
    
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

    const bot = new Bot(
      nme || process.env.CBOX_USERNAME!,
      key!,
      process.env.CBOX_DEFAULT_PIC || pic || "",
      new Gpt(),
      new MusicService(),
      new WebSocket(socketUrl!),
      boxId!,
      boxTag!,
      iframeUrl!
    );
    
    // Establecer el timestamp del login inicial
    bot.lastLoginTime = Date.now();
    
    bot.handleEvents();
  }

  // Método para renovar la sesión cuando sea necesario
  private async renewSessionIfNeeded(): Promise<boolean> {
    const currentTime = Date.now();
    const timeSinceLastLogin = currentTime - this.lastLoginTime;
    
    // Si ha pasado más de 1 hora desde el último login, renovar la sesión
    if (timeSinceLastLogin > this.SESSION_DURATION) {
      console.log(`🔄 Renovando sesión... (${Math.round(timeSinceLastLogin / (60 * 1000))} minutos desde último login)`);
      
      try {
        const dataLogin = await login({
          boxId: this.boxId,
          boxTag: this.boxTag,
          iframeUrl: this.iframeUrl,
          password: process.env.CBOX_PASSWORD!,
          username: process.env.CBOX_USERNAME!,
        });
        
        if (dataLogin.error) {
          console.error("❌ Error al renovar sesión:", dataLogin.error);
          return false;
        }
        
        const { nme, key, pic } = dataLogin.udata;
        
        // Actualizar datos de sesión
        this.uname = nme || process.env.CBOX_USERNAME!;
        this.ukey = key!;
        this.pic = process.env.CBOX_DEFAULT_PIC || pic || "";
        this.lastLoginTime = currentTime;
        
        console.log(`✅ Sesión renovada exitosamente para ${this.uname}`);
        return true;
      } catch (error) {
        console.error("❌ Error inesperado al renovar sesión:", error);
        return false;
      }
    }
    
    return true; // No necesita renovación
  }

  // Método auxiliar para enviar mensaje con renovación de sesión automática
  private async sendMessageWithSessionCheck(messageData: any): Promise<boolean> {
    // Verificar y renovar sesión si es necesario
    const sessionValid = await this.renewSessionIfNeeded();
    if (!sessionValid) {
      console.error("❌ No se pudo renovar la sesión, mensaje no enviado");
      return false;
    }
    
    // Actualizar datos del mensaje con la sesión actual
    const updatedMessageData = {
      ...messageData,
      key: this.ukey,
      username: this.uname,
      pic: this.pic,
    };
    
    try {
      await sendMessage(updatedMessageData);
      this.lastSentTime = Date.now();
      return true;
    } catch (error) {
      console.error("❌ Error al enviar mensaje:", error);
      return false;
    }
  }

  async handleEvents() {
    this.socket.on("open", () => {
      console.log("Conexión abierta");
    });

    // Manejar los mensajes recibidos del servidor
    this.socket.on("message", async (data: WebSocket.Data) => {
      const { date, id, lvl, message, name } = toDomain(data);

      // Solo guardar mensajes que NO sean del bot para evitar ciclos recursivos en resúmenes
      if (name && message && name !== this.uname) {
        await saveLog(name, message);
      } else if (name === this.uname && message) {
        // Log cuando se excluye un mensaje del bot (solo para debugging)
        console.log(`🚫 Mensaje del bot excluido del log: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`);
      }

      // Función auxiliar para verificar si el mensaje contiene el nombre exacto del bot
      const containsExactBotName = (msg: string, botName: string): boolean => {
        const lowerMsg = msg.toLowerCase();
        const lowerBotName = botName.toLowerCase();
        
        // Buscar el nombre como palabra completa (con límites de palabra)
        const regex = new RegExp(`\\b${lowerBotName}\\b`, 'i');
        return regex.test(lowerMsg);
      };

      // Función auxiliar para verificar si el mensaje contiene la palabra "bot"
      const containsBotWord = (msg: string): boolean => {
        const lowerMsg = msg.toLowerCase();
        // Buscar "bot" como palabra completa
        const botRegex = /\bbot\b/i;
        return botRegex.test(lowerMsg);
      };

      // Condiciones para responder:
      // 1. El mensaje no debe estar vacío
      // 2. El mensaje no debe ser del propio bot
      // 3. El mensaje debe contener:
      //    - La palabra "bot" (como palabra completa), O
      //    - El nombre exacto del bot (como palabra completa), O
      //    - Ser dirigido específicamente al bot (name === this.uname), O
      //    - Ser un comando de música (!music o solicitud natural)
      
      // Verificar primero si es solicitud de música
      // Agregar validación adicional para mensaje undefined/null
      const isMusicRequest = message ? MusicService.isMusicRequest(message) : false;
      
      if (
        !message ||
        name === this.uname ||
        (!containsBotWord(message) && !containsExactBotName(message, this.uname) && !isMusicRequest)
      )
        return;

      console.log(`Mensaje recibido: ${message} de ${name} el ${date}`);

      const _textColor = process.env.TEXT_COLOR;
      const textColor = _textColor ? `^#${_textColor} ` : "";

      // Verificar si es una solicitud de música ANTES de enviar a GPT
      console.log(`🔍 Verificando si "${message}" es solicitud de música...`);
      console.log(`🔍 Resultado detección música: ${isMusicRequest}`);
      
      if (isMusicRequest) {
        console.log(`🎵 Solicitud de música detectada de ${name}: "${message}"`);
        
        try {
          const query = MusicService.extractMusicQuery(message);
          console.log(`🔍 Query extraído: "${query}"`);
          
          if (!query || query.trim().length < 2) {
            const errorResponse = {
              message: `${textColor}<@${name}> ❌ No pude entender qué música quieres. Intenta con: "!music nombre de la canción" o "reproduce [nombre de la canción]"`,
              boxTag: this.boxTag,
              boxId: this.boxId,
              iframeUrl: this.iframeUrl,
            };
            await this.sendMessageWithSessionCheck(errorResponse);
            return;
          }

          // Enviar mensaje de confirmación
          const confirmationResponse = {
            message: `${textColor}<@${name}> 🎵 Buscando y descargando "${query}"... Esto puede tomar unos momentos.`,
            boxTag: this.boxTag,
            boxId: this.boxId,
            iframeUrl: this.iframeUrl,
          };
          await this.sendMessageWithSessionCheck(confirmationResponse);

          console.log(`🎵 Iniciando procesamiento de música para ${name}...`);
          
          // Procesar música de forma asíncrona
          this.musicService.processMusic(query, name)
            .then(async (result) => {
              console.log(`✅ Música procesada exitosamente: ${result.substring(0, 100)}...`);
              const musicResponse = {
                message: `${textColor}${result}`,
                boxTag: this.boxTag,
                boxId: this.boxId,
                iframeUrl: this.iframeUrl,
              };
              
              // Esperar el RESPONSE_DELAY antes de enviar
              await sleep(Number(process.env.RESPONSE_DELAY || 1000));
              await this.sendMessageWithSessionCheck(musicResponse);
            })
            .catch(async (error) => {
              console.error(`❌ Error en procesamiento de música:`, error);
              const errorResponse = {
                message: `${textColor}<@${name}> ❌ ${error.message}`,
                boxTag: this.boxTag,
                boxId: this.boxId,
                iframeUrl: this.iframeUrl,
              };
              
              await sleep(Number(process.env.RESPONSE_DELAY || 1000));
              await this.sendMessageWithSessionCheck(errorResponse);
            });

          console.log(`🎵 Retornando sin procesar con GPT para mensaje: "${message}"`);
          return; // No procesar con GPT
        } catch (error) {
          console.error(`❌ Error procesando solicitud de música:`, error);
          const errorResponse = {
            message: `${textColor}<@${name}> ❌ Error interno procesando música. Intenta más tarde.`,
            boxTag: this.boxTag,
            boxId: this.boxId,
            iframeUrl: this.iframeUrl,
          };
          await this.sendMessageWithSessionCheck(errorResponse);
          return;
        }
      }

      console.log(`🤖 Enviando mensaje a GPT: "${message}"`);
      const response = await this.gpt.chat(message, this.uname, name);

      if (!response) return;

      // Dividir la respuesta usando nuestra función local
      const maxLength = parseInt(process.env.MAX_LENGTH_RESPONSE || "200");
      const messageParts = splitMessageIntoParts(response, maxLength);

      // Crear los datos base para el mensaje
      const baseMessageData = {
        boxTag: this.boxTag,
        boxId: this.boxId,
        iframeUrl: this.iframeUrl,
      };

      // Crear las partes del mensaje con el formato correcto
      const messagesToSend = messageParts.map((part, index) => ({
        ...baseMessageData,
        message: index === 0 
          ? `${textColor}<@${name}> ${part}` // Primera parte con mención
          : `${textColor}${part}`, // Partes siguientes sin mención
      }));

      if (
        Date.now() - this.lastSentTime <
        Number(process.env.RESPONSE_DELAY || 20500)
      ) {
        // Agregar todos los mensajes a la cola
        messagesToSend.forEach(msgData => {
          this.responseQueue.push(msgData);
        });
        return;
      }

      const lastResumenEvent = await getLastEventType("Resumen");

      // Verificar si se solicitó resumen y si ha pasado suficiente tiempo
      if (response.includes("{{resumen}}")) {
        if (lastResumenEvent.minutesLeft < 10) {
          const responseData = {
            message: `${textColor}<@${name}> Puedes leer el resumen anterior y esperar 10 minutos para poder generar uno nuevo. 🙂`,
            boxTag: this.boxTag,
            boxId: this.boxId,
            iframeUrl: this.iframeUrl,
          };
          await this.sendMessageWithSessionCheck(responseData);
          return;
        }

        // Enviar mensaje de confirmación primero (sin {{resumen}})
        const confirmationMessage = response.replace("{{resumen}}", "").trim();
        const confirmationData = {
          message: `${textColor}<@${name}> ${confirmationMessage}`,
          boxTag: this.boxTag,
          boxId: this.boxId,
          iframeUrl: this.iframeUrl,
        };
        await this.sendMessageWithSessionCheck(confirmationData);

        // Esperar un momento antes de empezar a generar el resumen respetando RESPONSE_DELAY
        await sleep(Number(process.env.RESPONSE_DELAY || 1000));

        // Generar y enviar el resumen
        try {
          console.log("Generando resumen del chat...");
          const resumen = await this.gpt.generateSummary();
          
          // Dividir el resumen usando nuestra función local
          const resumenParts = splitMessageIntoParts(resumen, maxLength);
          
          console.log(`Enviando resumen en ${resumenParts.length} parte(s)`);
          
          // Enviar cada parte del resumen como mensaje independiente
          for (let i = 0; i < resumenParts.length; i++) {
            const part = resumenParts[i].trim();
            if (part) {
              // Formato mejorado para las partes del resumen
              const isFirstPart = i === 0;
              const isLastPart = i === resumenParts.length - 1;
              const partIndicator = resumenParts.length > 1 ? ` (${i + 1}/${resumenParts.length})` : "";
              
              let messagePrefix = "";
              if (isFirstPart) {
                messagePrefix = "📋✨ RESUMEN DEL CHAT" + partIndicator + "\n\n";
              } else {
                messagePrefix = `📋 RESUMEN${partIndicator}\n\n`;
              }
              
              let messageSuffix = "";
              if (isLastPart && resumenParts.length > 1) {
                messageSuffix = "\n\n¡Eso es todo por ahora! 🎬";
              }
              
              const responseData = {
                message: `${textColor}${messagePrefix}${part}${messageSuffix}`,
                boxTag: this.boxTag,
                boxId: this.boxId,
                iframeUrl: this.iframeUrl,
              };

              await this.sendMessageWithSessionCheck(responseData);
              
              // Esperar entre partes respetando el RESPONSE_DELAY del .env
              if (i < resumenParts.length - 1) {
                await sleep(Number(process.env.RESPONSE_DELAY || 1000));
              }
            }
          }
          
          // Guardar evento de resumen y limpiar log
          await saveEventsLog("Resumen", name);
          const clearedCount = await clearMessagesLog();
          console.log(`✅ Resumen completado y log limpiado (${clearedCount} mensajes eliminados)`);
          
        } catch (error) {
          console.error("Error generating summary:", error);
          const errorData = {
            message: `${textColor}❌ Error al generar el resumen. Inténtalo más tarde.`,
            boxTag: this.boxTag,
            boxId: this.boxId,
            iframeUrl: this.iframeUrl,
          };
          await this.sendMessageWithSessionCheck(errorData);
        }
        return;
      }

      // Comandos de debug especiales (solo para el creador)
      if (name === "Leon564" && message.toLowerCase().includes("debug")) {
        if (message.toLowerCase().includes("filter")) {
          console.log("🔧 Ejecutando debug de filtrado de mensajes...");
          await this.gpt.debugMessageFiltering();
          const debugResponse = {
            message: `${textColor}<@${name}> Debug de filtrado ejecutado. Revisa la consola para ver los resultados. 🔍`,
            boxTag: this.boxTag,
            boxId: this.boxId,
            iframeUrl: this.iframeUrl,
          };
          await this.sendMessageWithSessionCheck(debugResponse);
          return;
        }
        
        if (message.toLowerCase().includes("log")) {
          const history = await getLastMessages();
          const botMessages = history.filter((msg: any) => msg.user === this.uname);
          const userMessages = history.filter((msg: any) => msg.user !== this.uname);
          
          console.log(`📊 Análisis del log de mensajes:
            - Total mensajes: ${history.length}
            - Mensajes de usuarios: ${userMessages.length}
            - Mensajes del bot: ${botMessages.length}
            ${botMessages.length > 0 ? '⚠️ HAY MENSAJES DEL BOT EN EL LOG!' : '✅ No hay mensajes del bot en el log'}`);
          
          const debugResponse = {
            message: `${textColor}<@${name}> Log: ${history.length} total, ${userMessages.length} usuarios, ${botMessages.length} bot ${botMessages.length > 0 ? '⚠️' : '✅'}`,
            boxTag: this.boxTag,
            boxId: this.boxId,
            iframeUrl: this.iframeUrl,
          };
          await this.sendMessageWithSessionCheck(debugResponse);
          return;
        }
        
        if (message.toLowerCase().includes("config")) {
          const maxTokens = parseInt(process.env.MAX_LENGTH_RESPONSE || "500");
          const debugResponse = {
            message: `${textColor}<@${name}> Configuración: MAX_TOKENS=${maxTokens}, MEMORY=${Boolean(process.env.USE_MEMORY)} 🔧`,
            boxTag: this.boxTag,
            boxId: this.boxId,
            iframeUrl: this.iframeUrl,
          };
          await this.sendMessageWithSessionCheck(debugResponse);
          return;
        }
        
        if (message.toLowerCase().includes("music")) {
          const queueStatus = this.musicService.getQueueStatus();
          const debugResponse = {
            message: `${textColor}<@${name}> Música: Procesando=${queueStatus.isProcessing}, Cola=${queueStatus.queueLength} 🎵`,
            boxTag: this.boxTag,
            boxId: this.boxId,
            iframeUrl: this.iframeUrl,
          };
          await this.sendMessageWithSessionCheck(debugResponse);
          return;
        }
      }

      // Enviar respuesta normal
      if (messagesToSend.length === 1) {
        // Mensaje único, enviar directamente
        await this.sendMessageWithSessionCheck(messagesToSend[0]);
      } else {
        // Mensajes múltiples, enviar con delay
        await this.sendMessageWithSessionCheck(messagesToSend[0]);
        
        // Enviar las partes restantes con delay
        for (let i = 1; i < messagesToSend.length; i++) {
          await sleep(Number(process.env.RESPONSE_DELAY || 1000));
          await this.sendMessageWithSessionCheck(messagesToSend[i]);
        }
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
