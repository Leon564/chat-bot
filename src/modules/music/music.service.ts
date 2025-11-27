import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as ytdl from "@distube/ytdl-core";
import * as ffmpeg from "fluent-ffmpeg";
import * as ffmpegPath from "@ffmpeg-installer/ffmpeg";
import * as ytsr from "ytsr";
import { Stream, Readable } from "stream";
import * as fs from "fs";
import * as path from "path";
import * as FormData from "form-data";
import fetch from "node-fetch";
import * as he from "he";
import YTDlpWrap from "yt-dlp-wrap";
import {
  MusicRequest,
  YouTubeCookie,
  QueueStatus,
} from "../../common/interfaces";

// Configurar ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath.path);

@Injectable()
export class MusicService {
  private isProcessing: boolean;
  private queue: MusicRequest[];
  private uploadService: "catbox" | "litterbox";
  private litterboxExpiry: string;
  private youtubeCookies: any | null; // Cambiar de string a any para el jar de cookies
  private ytdlp: YTDlpWrap;

  constructor(private readonly configService: ConfigService) {
    this.isProcessing = false;
    this.queue = [];

    // Configurar servicio de subida desde variables de entorno
    this.uploadService =
      (this.configService.get<string>("music.uploadService") as
        | "catbox"
        | "litterbox") || "catbox";
    this.litterboxExpiry =
      this.configService.get<string>("music.litterboxExpiry") || "1h";

    console.log(`🔧 [CONFIG] Servicio de subida: ${this.uploadService}`);
    if (this.uploadService === "litterbox") {
      console.log(`🔧 [CONFIG] Expiración Litterbox: ${this.litterboxExpiry}`);
    }

    // Cargar cookies de YouTube si están configuradas
    this.youtubeCookies = this.loadYouTubeCookies();
    if (this.youtubeCookies) {
      console.log(`🍪 [CONFIG] Cookies de YouTube cargadas exitosamente`);
    } else {
      console.log(`🍪 [CONFIG] Sin cookies de YouTube - usando acceso público`);
    }

    // Inicializar yt-dlp
    this.ytdlp = new YTDlpWrap();
    console.log(`🔧 [YT-DLP] Inicializado como fallback`);
    
    // Asegurar que yt-dlp esté disponible de forma asíncrona (no bloquear la inicialización)
    this.ensureYtDlpAvailable().then(() => {
      console.log(`✅ [YT-DLP] yt-dlp está listo para usar`);
    }).catch(error => {
      console.warn(`⚠️ [YT-DLP] yt-dlp no está disponible, solo se usará ytdl-core:`, error instanceof Error ? error.message : error);
    });
  }

  private async ensureYtDlpAvailable(): Promise<void> {
    try {
      // Verificar si yt-dlp está disponible
      await this.ytdlp.exec(['--version']);
      console.log(`✅ [YT-DLP] yt-dlp está disponible`);
    } catch (error) {
      console.log(`📥 [YT-DLP] yt-dlp no encontrado, intentando descarga automática...`);
      try {
        // Descargar yt-dlp automáticamente
        await YTDlpWrap.downloadFromGithub();
        console.log(`✅ [YT-DLP] yt-dlp descargado exitosamente`);
        
        // Verificar que funcione después de la descarga
        await this.ytdlp.exec(['--version']);
        console.log(`✅ [YT-DLP] yt-dlp verificado después de descarga`);
      } catch (downloadError) {
        console.error(`❌ [YT-DLP] Error descargando o verificando yt-dlp:`, downloadError);
        throw new Error(`No se pudo configurar yt-dlp: ${downloadError instanceof Error ? downloadError.message : downloadError}`);
      }
    }
  }

  private async isYtDlpAvailable(): Promise<boolean> {
    try {
      await this.ytdlp.exec(['--version']);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Detecta si un mensaje es una solicitud de música
   */
  static isMusicRequest(message: string): boolean {
    // Validar que el mensaje existe y no es nulo/undefined
    if (!message || typeof message !== "string") {
      console.log(`🔍 [DEBUG] Mensaje inválido para detección de música:`, {
        message,
        type: typeof message,
      });
      return false;
    }

    // Decodificar entidades HTML antes de procesar
    const decodedMessage = he.decode(message);
    const lowerMessage = decodedMessage.toLowerCase();

    // Detectar comando directo !music
    if (lowerMessage.match(/^!music\s+.+/)) {
      return true;
    }

    // Detectar solicitudes naturales de música
    const musicKeywords = [
      "reproduce",
      "pon música",
      "pon musica",
      "play music",
      "reproduce canción",
      "reproduce cancion",
      "quiero escuchar",
      "busca la canción",
      "busca la cancion",
      "música de",
      "musica de",
      "canción de",
      "cancion de",
      "tema de",
      "song by",
      "play song",
      "escuchar música",
      "escuchar musica",
    ];

    return musicKeywords.some((keyword) => lowerMessage.includes(keyword));
  }

  /**
   * Extrae el query de búsqueda del mensaje
   */
  static extractMusicQuery(message: string): string {
    // Validar que el mensaje existe y no es nulo/undefined
    if (!message || typeof message !== "string") {
      console.log(`🔍 [DEBUG] Mensaje inválido para extracción de query:`, {
        message,
        type: typeof message,
      });
      return "";
    }

    // Decodificar entidades HTML antes de procesar
    const decodedMessage = he.decode(message);

    // Si es comando directo !music
    const commandMatch = decodedMessage.match(/^!music\s+(.+)/i);
    if (commandMatch) {
      return commandMatch[1].trim();
    }

    // Patrones para extraer el nombre de la canción de solicitudes naturales
    const patterns = [
      /reproduce\s+(?:la\s+canción\s+|la\s+cancion\s+|canción\s+|cancion\s+)?["']?([^"']+)["']?/i,
      /pon\s+música\s+de\s+["']?([^"']+)["']?/i,
      /pon\s+musica\s+de\s+["']?([^"']+)["']?/i,
      /quiero\s+escuchar\s+["']?([^"']+)["']?/i,
      /busca\s+(?:la\s+)?canción\s+["']?([^"']+)["']?/i,
      /busca\s+(?:la\s+)?cancion\s+["']?([^"']+)["']?/i,
      /música\s+de\s+["']?([^"']+)["']?/i,
      /musica\s+de\s+["']?([^"']+)["']?/i,
      /canción\s+de\s+["']?([^"']+)["']?/i,
      /cancion\s+de\s+["']?([^"']+)["']?/i,
      /tema\s+de\s+["']?([^"']+)["']?/i,
      /play\s+["']?([^"']+)["']?/i,
      /song\s+by\s+["']?([^"']+)["']?/i,
    ];

    for (const pattern of patterns) {
      const match = decodedMessage.match(pattern);
      if (match && match[1]) {
        const extractedQuery = match[1].trim();
        console.log(
          `🔍 [DEBUG] Query extraído con patrón ${pattern}: "${extractedQuery}"`
        );
        return extractedQuery;
      }
    }

    console.log(
      `🔍 [DEBUG] No se pudo extraer query del mensaje: "${decodedMessage}"`
    );
    return "";
  }

  /**
   * Procesa una solicitud de música
   */
  async processMusic(query: string, username: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const request: MusicRequest = {
        query,
        username,
        resolve,
        reject,
      };

      this.queue.push(request);
      console.log(
        `🎵 [QUEUE] Solicitud añadida a la cola. Total en cola: ${this.queue.length}`
      );

      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  }

  /**
   * Obtiene el estado de la cola de procesamiento
   */
  getQueueStatus(): QueueStatus {
    return {
      isProcessing: this.isProcessing,
      queueLength: this.queue.length,
    };
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    console.log(
      `🎵 [QUEUE] Iniciando procesamiento de cola. ${this.queue.length} elementos pendientes`
    );

    while (this.queue.length > 0) {
      const request = this.queue.shift()!;
      try {
        console.log(
          `🎵 [PROCESSING] Procesando: "${request.query}" para ${request.username}`
        );
        const result = await this.processSingleMusicRequest(
          request.query,
          request.username
        );
        request.resolve(result);
      } catch (error) {
        console.error(`🎵 [ERROR] Error procesando "${request.query}":`, error);
        request.reject(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    this.isProcessing = false;
    console.log(`🎵 [QUEUE] Cola de procesamiento completada`);
  }

  private async processSingleMusicRequest(
    query: string,
    username: string
  ): Promise<string> {
    console.log(`🔍 [SEARCH] Buscando en YouTube: "${query}"`);

    try {
      // Buscar en YouTube
      const searchResults = await ytsr(query, { limit: 5 });
      const videos = searchResults.items.filter(
        (item: any) => item.type === "video"
      );

      if (videos.length === 0) {
        throw new Error(`No se encontraron resultados para "${query}"`);
      }

      const video = videos[0] as any;
      console.log(
        `🎯 [FOUND] Video encontrado: "${video.title}" - ${video.url}`
      );

      // Intentar descarga con diferentes configuraciones
      const maxDownloadRetries = 3;
      let audioBuffer = null;
      let lastError = null;

      // Primero intentar con ytdl-core
      console.log(`⬇️ [YTDL-CORE] Intentando descarga con @distube/ytdl-core...`);
      
      for (let attempt = 1; attempt <= maxDownloadRetries; attempt++) {
        try {
          console.log(`⬇️ [DOWNLOAD] Intento ${attempt}/${maxDownloadRetries} - Descargando: ${video.url}`);
          
          // Configurar opciones de ytdl progresivamente más agresivas
          const ytdlOptions: any = {
            quality: attempt === 1 ? "highestaudio" : (attempt === 2 ? "highest" : "lowest"),
            filter: attempt <= 2 ? "audioonly" : undefined,
          };

          // Configuración de headers más robusta
          if (this.youtubeCookies) {
            ytdlOptions.cookies = this.youtubeCookies;
            console.log(`🍪 [YTDL] Usando cookies en intento ${attempt}`);
          }

          // Opciones adicionales para evitar bloqueos
          if (attempt >= 2) {
            ytdlOptions.lang = 'en';
            ytdlOptions.requestOptions = {
              headers: {
                'User-Agent': this.getRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-us,en;q=0.5',
                'Sec-Fetch-Mode': 'navigate',
              }
            };
          }

          if (attempt === 3) {
            // Último intento con configuración más básica
            console.log(`🔄 [DOWNLOAD] Intento final con configuración básica`);
            delete ytdlOptions.filter;
            ytdlOptions.quality = 'lowest';
          }

          // Obtener el stream
          const audioStream = ytdl(video.url, ytdlOptions);
          
          // Convertir stream a buffer con timeout específico para este intento
          console.log(`📦 [BUFFER] Convirtiendo stream a buffer (intento ${attempt})...`);
          audioBuffer = await this.streamToBuffer(audioStream, attempt * 30000); // 30s, 60s, 90s
          console.log(`✅ [BUFFER] Buffer creado exitosamente en intento ${attempt}: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`);
          break; // Salir del loop si fue exitoso

        } catch (error) {
          lastError = error;
          console.error(`❌ [DOWNLOAD] Error en intento ${attempt}:`, error instanceof Error ? error.message : error);
          
          if (attempt < maxDownloadRetries) {
            const delay = attempt * 3000; // 3s, 6s, 9s
            console.log(`⏱️ [DOWNLOAD] Esperando ${delay}ms antes del siguiente intento...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      // Si ytdl-core falló, intentar con yt-dlp como fallback
      if (!audioBuffer) {
        console.log(`🔄 [YT-DLP] ytdl-core falló, verificando disponibilidad de yt-dlp...`);
        
        // Verificar si yt-dlp está disponible antes de intentar usarlo
        const ytdlpAvailable = await this.isYtDlpAvailable();
        
        if (ytdlpAvailable) {
          try {
            console.log(`🔄 [YT-DLP] Intentando descarga con yt-dlp como fallback...`);
            audioBuffer = await this.downloadWithYtDlp(video.url);
            console.log(`✅ [YT-DLP] Descarga exitosa con yt-dlp: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`);
          } catch (ytdlpError) {
            console.error(`❌ [YT-DLP] Error con yt-dlp:`, ytdlpError instanceof Error ? ytdlpError.message : ytdlpError);
            throw new Error(`No se pudo descargar el audio con ningún método. ytdl-core: ${lastError instanceof Error ? lastError.message : lastError}. yt-dlp: ${ytdlpError instanceof Error ? ytdlpError.message : ytdlpError}`);
          }
        } else {
          console.warn(`⚠️ [YT-DLP] yt-dlp no está disponible, no se puede usar como fallback`);
          throw new Error(`No se pudo descargar el audio. ytdl-core falló: ${lastError instanceof Error ? lastError.message : lastError}. yt-dlp no está disponible.`);
        }
      }

      // Convertir a MP3
      const tempDir = path.join(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const sanitizedUsername = username.replace(/[^\w\-_.]/g, '').substring(0, 20) || 'user';
      const filename = `music_${Date.now()}_${sanitizedUsername}.mp3`;
      const outputPath = path.join(tempDir, filename);

      await this.convertBufferToMp3(audioBuffer, outputPath);
      console.log(`✅ [CONVERT] Audio convertido a MP3: ${outputPath}`);

      // Subir archivo
      try {
        const uploadUrl = await this.uploadFile(outputPath);
        console.log(`☁️ [UPLOAD] Archivo subido exitosamente: ${uploadUrl}`);

        // Limpiar archivo temporal
        fs.unlinkSync(outputPath);
        console.log(`🗑️ [CLEANUP] Archivo temporal eliminado: ${outputPath}`);

        return `🎵 <@${username}> Aquí tienes "${video.title}": [audio]${uploadUrl}[/audio]`;
      } catch (uploadError) {
        const uploadErrorMsg = uploadError instanceof Error ? uploadError.message : String(uploadError);
        
        // Si es un problema de conectividad, mantener el archivo y dar instrucciones
        if (uploadErrorMsg.includes('temporalmente no disponibles')) {
          console.log(`💾 [BACKUP] Manteniendo archivo local debido a problemas de conectividad: ${outputPath}`);
          return `🎵 <@${username}> Audio "${video.title}" procesado pero los servicios de subida están temporalmente no disponibles. El archivo se ha guardado localmente. Por favor, intenta nuevamente en unos minutos.`;
        }
        
        // Para otros errores, limpiar archivo y relanzar error
        fs.unlinkSync(outputPath);
        throw uploadError;
      }
    } catch (error) {
      console.error(`❌ [ERROR] Error en procesamiento de música:`, error);
      throw new Error(
        `Error procesando música: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private convertToMp3(
    inputStream: Readable,
    outputPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputStream)
        .toFormat("mp3")
        .audioBitrate(128)
        .audioChannels(2)
        .audioFrequency(44100)
        .output(outputPath)
        .on("end", () => {
          console.log(`🔄 [FFMPEG] Conversión completada: ${outputPath}`);
          resolve();
        })
        .on("error", (error) => {
          console.error(`❌ [FFMPEG] Error en conversión:`, error);
          reject(error);
        })
        .run();
    });
  }

  private async streamToBuffer(stream: Readable, timeoutMs: number = 5 * 60 * 1000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        totalSize += chunk.length;
        
        // Log progreso cada 5MB
        if (totalSize % (5 * 1024 * 1024) < chunk.length) {
          console.log(`📦 [BUFFER] Descargado: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
        }
      });

      stream.on('end', () => {
        const buffer = Buffer.concat(chunks, totalSize);
        console.log(`✅ [BUFFER] Stream completo: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
        clearTimeout(timeout);
        resolve(buffer);
      });

      stream.on('error', (error) => {
        console.error(`❌ [BUFFER] Error en stream:`, error);
        clearTimeout(timeout);
        reject(error);
      });

      // Timeout configurable para el stream
      const timeout = setTimeout(() => {
        stream.destroy();
        reject(new Error(`Timeout: El stream tardó más de ${timeoutMs / 1000} segundos`));
      }, timeoutMs);
    });
  }

  private async convertBufferToMp3(buffer: Buffer, outputPath: string): Promise<void> {
    const { Readable } = require('stream');
    
    return new Promise((resolve, reject) => {
      // Crear un stream readable desde el buffer
      const bufferStream = new Readable({
        read() {
          this.push(buffer);
          this.push(null); // Finalizar el stream
        }
      });

      console.log(`🔄 [FFMPEG] Iniciando conversión desde buffer (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);

      ffmpeg(bufferStream)
        .toFormat("mp3")
        .audioBitrate(128)
        .audioChannels(2)
        .audioFrequency(44100)
        .output(outputPath)
        .on("start", (commandLine) => {
          console.log(`🔄 [FFMPEG] Comando: ${commandLine}`);
        })
        .on("progress", (progress) => {
          if (progress.percent) {
            console.log(`🔄 [FFMPEG] Progreso: ${Math.round(progress.percent)}%`);
          }
        })
        .on("end", () => {
          console.log(`✅ [FFMPEG] Conversión completada desde buffer: ${outputPath}`);
          resolve();
        })
        .on("error", (error) => {
          console.error(`❌ [FFMPEG] Error en conversión desde buffer:`, error);
          reject(error);
        })
        .run();
    });
  }

  private async uploadFile(filePath: string): Promise<string> {
    // Verificar conectividad básica antes de intentar uploads
    console.log(`🌐 [CONNECTIVITY] Verificando conectividad de red...`);
    
    try {
      // Test básico de conectividad DNS
      await this.testConnectivity();
      console.log(`✅ [CONNECTIVITY] Conectividad verificada`);
    } catch (connectivityError) {
      console.error(`❌ [CONNECTIVITY] Sin conectividad de red:`, connectivityError instanceof Error ? connectivityError.message : connectivityError);
      throw new Error(`❌ Sin conectividad a internet. Verifica tu conexión de red.`);
    }

    // Siempre intentar Catbox primero
    const maxRetries = 3;
    const retryDelay = 2000;

    console.log(`📤 [UPLOAD] Intentando subir a Catbox primero...`);
    
    // Intentar Catbox con reintentos
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`📤 [CATBOX] Intento ${attempt}/${maxRetries} - Subiendo archivo...`);
        return await this.uploadToCatboxWithRetry(filePath);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`❌ [CATBOX] Error en intento ${attempt}:`, errorMsg);
        
        // Verificar si es un error de conectividad DNS
        if (errorMsg.includes('getaddrinfo ENOTFOUND') || errorMsg.includes('ENOTFOUND')) {
          console.log(`🌐 [DNS] Problema de conectividad detectado con Catbox`);
        }
        
        if (attempt === maxRetries) {
          console.log(`🔄 [FALLBACK] Catbox falló después de ${maxRetries} intentos, intentando con Litterbox (72h)...`);
          break; // Salir para intentar el fallback
        }
        
        // Esperar antes del siguiente intento (más tiempo si es problema DNS)
        if (attempt < maxRetries) {
          const delay = errorMsg.includes('ENOTFOUND') ? retryDelay * 2 : retryDelay;
          console.log(`⏱️ Esperando ${delay}ms antes del siguiente intento...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // Fallback a Litterbox con 72h (fijo, no depende del .env)
    try {
      const result = await this.uploadToLitterboxFallback(filePath);
      console.log(`✅ [FALLBACK] Archivo subido exitosamente a Litterbox como fallback`);
      return result;
    } catch (fallbackError) {
      const fallbackErrorMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      
      // Si ambos servicios fallan por problemas de conectividad, dar un mensaje más útil
      if (fallbackErrorMsg.includes('getaddrinfo ENOTFOUND') || fallbackErrorMsg.includes('ENOTFOUND')) {
        console.error(`🌐 [DNS] Problema de conectividad detectado con ambos servicios`);
        throw new Error(`❌ Servicios de subida temporalmente no disponibles. Verifica tu conexión a internet y intenta nuevamente en unos minutos.`);
      }
      
      throw new Error(`Error en Catbox y Litterbox fallback: ${fallbackErrorMsg}`);
    }
  }

  private async testConnectivity(): Promise<void> {
    try {
      // Test simple con Google DNS (más confiable)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch('https://dns.google/resolve?name=catbox.moe&type=A', {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`DNS test failed: ${response.status}`);
      }

      const result = await response.json();
      
      if (!result.Answer || result.Answer.length === 0) {
        throw new Error('DNS resolution failed');
      }

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('DNS test timeout');
      }
      throw error;
    }
  }

  private async uploadToCatbox(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", fs.createReadStream(filePath));

    const response = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "accept-language": "es-419,es;q=0.9,es-ES;q=0.8,en;q=0.7,en-GB;q=0.6,en-US;q=0.5,es-US;q=0.4",
        "cache-control": "no-cache",
        "priority": "u=1, i",
        "sec-ch-ua": "\"Chromium\";v=\"142\", \"Microsoft Edge\";v=\"142\", \"Not_A Brand\";v=\"99\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-requested-with": "XMLHttpRequest",
        "Referer": "https://catbox.moe/"
      },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Error subiendo a Catbox: ${response.statusText}`);
    }

    const result = await response.text();

    if (!result.startsWith("https://")) {
      throw new Error(`Respuesta inválida de Catbox: ${result}`);
    }

    return result;
  }

  private async uploadToLitterbox(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("time", this.litterboxExpiry);
    form.append("fileToUpload", fs.createReadStream(filePath));

    const response = await fetch(
      "https://litterbox.catbox.moe/resources/internals/api.php",
      {
        method: "POST",
        body: form,
      }
    );

    if (!response.ok) {
      throw new Error(`Error subiendo a Litterbox: ${response.statusText}`);
    }

    const result = await response.text();

    if (!result.startsWith("https://")) {
      throw new Error(`Respuesta inválida de Litterbox: ${result}`);
    }

    return result;
  }

  private async uploadToCatboxWithRetry(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", fs.createReadStream(filePath));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 segundos timeout

    try {
      const response = await fetch("https://catbox.moe/user/api.php", {
        method: "POST",
        headers: {
          "accept": "application/json",
          "accept-language": "es-419,es;q=0.9,es-ES;q=0.8,en;q=0.7,en-GB;q=0.6,en-US;q=0.5,es-US;q=0.4",
          "cache-control": "no-cache",
          "priority": "u=1, i",
          "sec-ch-ua": "\"Chromium\";v=\"142\", \"Microsoft Edge\";v=\"142\", \"Not_A Brand\";v=\"99\"",
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": "\"Windows\"",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "x-requested-with": "XMLHttpRequest",
          "Referer": "https://catbox.moe/"
        },
        body: form,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Error subiendo a Catbox: ${response.statusText}`);
      }

      const result = await response.text();

      if (!result.startsWith("https://")) {
        throw new Error(`Respuesta inválida de Catbox: ${result}`);
      }

      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Timeout al subir archivo a Catbox (30s)');
      }
      throw error;
    }
  }

  private async uploadToLitterboxFallback(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("time", "72h"); // Fijo en 72h para fallback
    form.append("fileToUpload", fs.createReadStream(filePath));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000); // 45 segundos timeout (más tiempo que Catbox)

    try {
      console.log(`📤 [LITTERBOX-FALLBACK] Subiendo con expiración de 72h...`);
      
      const response = await fetch(
        "https://litterbox.catbox.moe/resources/internals/api.php",
        {
          method: "POST",
          body: form,
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Error subiendo a Litterbox fallback: ${response.statusText}`);
      }

      const result = await response.text();

      if (!result.startsWith("https://")) {
        throw new Error(`Respuesta inválida de Litterbox fallback: ${result}`);
      }

      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Timeout al subir archivo a Litterbox fallback (45s)');
      }
      throw error;
    }
  }

  private loadYouTubeCookies(): any | null {
    try {
      const cookiesPath = this.configService.get<string>(
        "music.youtubeCookiesPath"
      );

      if (!cookiesPath) {
        console.log(
          `🍪 [DEBUG] No se especificó YOUTUBE_COOKIES_PATH en la configuración`
        );
        return null;
      }

      // Resolver ruta relativa desde el directorio raíz del proyecto
      const fullPath = path.resolve(cookiesPath);

      if (!fs.existsSync(fullPath)) {
        console.log(`🍪 [DEBUG] Archivo de cookies no encontrado: ${fullPath}`);
        return null;
      }

      console.log(`🍪 [DEBUG] Cargando cookies desde: ${fullPath}`);
      const cookiesData = fs.readFileSync(fullPath, "utf8");

      if (!cookiesData.trim()) {
        console.log(`🍪 [DEBUG] Archivo de cookies vacío`);
        return null;
      }

      const cookies: YouTubeCookie[] = JSON.parse(cookiesData);

      if (!Array.isArray(cookies) || cookies.length === 0) {
        console.log(`🍪 [DEBUG] Archivo de cookies vacío o formato inválido`);
        return null;
      }

      // Validar que las cookies tengan el formato correcto
      const validCookies = cookies.filter(
        (cookie) =>
          cookie.name &&
          cookie.value &&
          typeof cookie.name === "string" &&
          typeof cookie.value === "string"
      );

      if (validCookies.length === 0) {
        console.log(
          `🍪 [DEBUG] No se encontraron cookies válidas en el archivo`
        );
        return null;
      }

      if (validCookies.length !== cookies.length) {
        console.log(
          `🍪 [WARNING] Se ignoraron ${cookies.length - validCookies.length} cookies con formato inválido`
        );
      }

      // Convertir cookies al formato requerido por @distube/ytdl-core
      const cookieJar = validCookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || '.youtube.com',
        path: cookie.path || '/',
        secure: cookie.secure !== false, // Default a true
        httpOnly: cookie.httpOnly || false,
        sameSite: cookie.sameSite || 'Lax'
      }));

      console.log(
        `🍪 [DEBUG] ${validCookies.length} cookies válidas cargadas en nuevo formato`
      );
      
      return cookieJar;
    } catch (error) {
      console.error(`🍪 [ERROR] Error cargando cookies de YouTube:`, error);
      return null;
    }
  }

  private getRandomUserAgent(): string {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  private async downloadWithYtDlp(videoUrl: string): Promise<Buffer> {
    // Verificar disponibilidad primero
    const available = await this.isYtDlpAvailable();
    if (!available) {
      throw new Error('yt-dlp no está disponible en el sistema');
    }

    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = Date.now();
    const tempFilePath = path.join(tempDir, `ytdlp_${timestamp}.%(ext)s`);
    const args = [
      videoUrl,
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '128K',
      '--output', tempFilePath,
      '--no-playlist',
      '--ignore-errors',
      '--no-warnings',
      '--user-agent', this.getRandomUserAgent()
    ];

    // Agregar cookies si están disponibles
    let cookiesFile = null;
    if (this.youtubeCookies) {
      cookiesFile = path.join(tempDir, `cookies_${timestamp}.txt`);
      try {
        // Convertir cookies JSON a formato Netscape para yt-dlp
        const netscapeCookies = this.convertCookiesToNetscape(this.youtubeCookies);
        fs.writeFileSync(cookiesFile, netscapeCookies);
        args.push('--cookies', cookiesFile);
        console.log(`🍪 [YT-DLP] Usando archivo de cookies: ${cookiesFile}`);
      } catch (cookieError) {
        console.warn(`⚠️ [YT-DLP] Error preparando cookies, continuando sin ellas:`, cookieError);
        cookiesFile = null;
      }
    }

    try {
      console.log(`🚀 [YT-DLP] Ejecutando descarga...`);
      
      const result = await this.ytdlp.exec(args);
      console.log(`📋 [YT-DLP] Resultado:`, result);
      
      // Buscar el archivo descargado (puede tener diferentes extensiones)
      const files = fs.readdirSync(tempDir).filter(file => 
        file.startsWith(`ytdlp_${timestamp}`) && 
        (file.endsWith('.mp3') || file.endsWith('.m4a') || file.endsWith('.webm') || file.endsWith('.ogg'))
      );
      
      if (files.length === 0) {
        // Listar todos los archivos para debug
        const allFiles = fs.readdirSync(tempDir);
        console.log(`🔍 [YT-DLP] Archivos en directorio temporal:`, allFiles);
        throw new Error('No se encontró el archivo descargado por yt-dlp');
      }

      const downloadedFile = path.join(tempDir, files[0]);
      console.log(`📁 [YT-DLP] Archivo descargado: ${downloadedFile}`);
      
      // Verificar que el archivo existe y tiene contenido
      const stats = fs.statSync(downloadedFile);
      if (stats.size === 0) {
        throw new Error('El archivo descargado está vacío');
      }
      
      // Leer el archivo y convertirlo a buffer
      const buffer = fs.readFileSync(downloadedFile);
      console.log(`✅ [YT-DLP] Buffer creado: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
      
      // Limpiar archivos temporales
      fs.unlinkSync(downloadedFile);
      
      return buffer;
    } catch (error) {
      console.error(`❌ [YT-DLP] Error en descarga:`, error);
      
      // Mejorar el mensaje de error
      if (error instanceof Error) {
        if (error.message.includes('spawn yt-dlp ENOENT')) {
          throw new Error('yt-dlp no está instalado o no es ejecutable');
        }
        throw new Error(`yt-dlp falló: ${error.message}`);
      }
      throw new Error(`yt-dlp falló: ${String(error)}`);
    } finally {
      // Limpiar archivo de cookies si se creó
      if (cookiesFile && fs.existsSync(cookiesFile)) {
        try {
          fs.unlinkSync(cookiesFile);
        } catch (e) {
          // Ignorar errores de limpieza
        }
      }
    }
  }

  private convertCookiesToNetscape(cookies: any[]): string {
    const header = '# Netscape HTTP Cookie File\n# This is a generated file! Do not edit.\n\n';
    const lines = cookies.map(cookie => {
      const domain = cookie.domain || '.youtube.com';
      const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const path = cookie.path || '/';
      const secure = cookie.secure ? 'TRUE' : 'FALSE';
      const expiry = cookie.expirationDate || '0';
      
      return `${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${cookie.name}\t${cookie.value}`;
    });
    
    return header + lines.join('\n') + '\n';
  }
}
