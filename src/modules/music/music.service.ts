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

      // Si no se pudo obtener el buffer después de todos los intentos
      if (!audioBuffer) {
        throw new Error(`No se pudo descargar el audio después de ${maxDownloadRetries} intentos. Último error: ${lastError instanceof Error ? lastError.message : lastError}`);
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
      const uploadUrl = await this.uploadFile(outputPath);
      console.log(`☁️ [UPLOAD] Archivo subido exitosamente: ${uploadUrl}`);

      // Limpiar archivo temporal
      fs.unlinkSync(outputPath);
      console.log(`🗑️ [CLEANUP] Archivo temporal eliminado: ${outputPath}`);

      return `🎵 <@${username}> Aquí tienes "${video.title}": [audio]${uploadUrl}[/audio]`;
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
    if (this.uploadService === "litterbox") {
      return this.uploadToLitterbox(filePath);
    } else {
      return this.uploadToCatbox(filePath);
    }
  }

  private async uploadToCatbox(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", fs.createReadStream(filePath));

    const response = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
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
}
