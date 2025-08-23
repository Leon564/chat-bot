import ytdl from '@distube/ytdl-core';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ytsr from 'ytsr';
import { Stream, Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';
import fetch from 'node-fetch';

// Configurar ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath.path);

interface MusicRequest {
  query: string;
  username: string;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
}

export class MusicService {
  private isProcessing: boolean;
  private queue: MusicRequest[];
  private uploadService: 'catbox' | 'litterbox';
  private litterboxExpiry: string;

  constructor() {
    this.isProcessing = false;
    this.queue = [];
    
    // Configurar servicio de subida desde variables de entorno
    this.uploadService = (process.env.UPLOAD_SERVICE as 'catbox' | 'litterbox') || 'catbox';
    this.litterboxExpiry = process.env.LITTERBOX_EXPIRY || '1h';
    
    console.log(`🔧 [CONFIG] Servicio de subida: ${this.uploadService}`);
    if (this.uploadService === 'litterbox') {
      console.log(`🔧 [CONFIG] Expiración Litterbox: ${this.litterboxExpiry}`);
    }
  }

  /**
   * Detecta si un mensaje es una solicitud de música
   * @param message Mensaje del usuario
   * @returns true si es una solicitud de música
   */
  static isMusicRequest(message: string): boolean {
    // Validar que el mensaje existe y no es nulo/undefined
    if (!message || typeof message !== 'string') {
      console.log(`🔍 [DEBUG] Mensaje inválido para detección de música:`, { message, type: typeof message });
      return false;
    }
    
    const lowerMessage = message.toLowerCase();
    
    // Detectar comando directo !music
    if (lowerMessage.match(/^!music\s+.+/)) {
      return true;
    }
    
    // Detectar solicitudes naturales de música
    const musicKeywords = [
      'reproduce',
      'pon música',
      'pon musica',
      'play music',
      'reproduce canción',
      'reproduce cancion',
      'quiero escuchar',
      'busca la canción',
      'busca la cancion',
      'música de',
      'musica de',
      'canción de',
      'cancion de',
      'tema de',
      'song by',
      'play song',
      'escuchar música',
      'escuchar musica'
    ];
    
    return musicKeywords.some(keyword => lowerMessage.includes(keyword));
  }

  /**
   * Extrae el query de búsqueda del mensaje
   * @param message Mensaje del usuario
   * @returns Query de búsqueda limpio
   */
  static extractMusicQuery(message: string): string {
    // Validar que el mensaje existe y no es nulo/undefined
    if (!message || typeof message !== 'string') {
      console.log(`🔍 [DEBUG] Mensaje inválido para extracción de query:`, { message, type: typeof message });
      return '';
    }
    
    const lowerMessage = message.toLowerCase();
    
    // Si es comando directo !music
    const commandMatch = message.match(/^!music\s+(.+)/i);
    if (commandMatch) {
      return commandMatch[1].trim();
    }
    
    // Patrones para extraer el nombre de la canción de solicitudes naturales
    const patterns = [
      /reproduce\s+(?:la\s+canción\s+|la\s+cancion\s+|canción\s+|cancion\s+)?["']?([^"']+)["']?/i,
      /pon\s+música\s+de\s+["']?([^"']+)["']?/i,
      /pon\s+musica\s+de\s+["']?([^"']+)["']?/i,
      /quiero\s+escuchar\s+["']?([^"']+)["']?/i,
      /busca\s+la\s+canción\s+["']?([^"']+)["']?/i,
      /busca\s+la\s+cancion\s+["']?([^"']+)["']?/i,
      /música\s+de\s+["']?([^"']+)["']?/i,
      /musica\s+de\s+["']?([^"']+)["']?/i,
      /canción\s+de\s+["']?([^"']+)["']?/i,
      /cancion\s+de\s+["']?([^"']+)["']?/i,
      /tema\s+de\s+["']?([^"']+)["']?/i,
      /play\s+music\s+["']?([^"']+)["']?/i,
      /play\s+song\s+["']?([^"']+)["']?/i,
      /song\s+by\s+["']?([^"']+)["']?/i,
      /escuchar\s+música\s+de\s+["']?([^"']+)["']?/i,
      /escuchar\s+musica\s+de\s+["']?([^"']+)["']?/i
    ];
    
    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    
    // Fallback: remover menciones y palabras comunes, devolver el resto
    return message
      .replace(/@\w+/g, '') // Remover menciones
      .replace(/\b(reproduce|pon|música|musica|canción|cancion|busca|quiero|escuchar|la|de|el|una|un)\b/gi, '')
      .trim();
  }

  /**
   * Procesa una solicitud de música
   * @param query Query de búsqueda
   * @param username Usuario que hizo la solicitud
   * @returns Promise con el enlace de audio o mensaje de error
   */
  async processMusic(query: string, username: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const request: MusicRequest = {
        query,
        username,
        resolve,
        reject
      };

      if (this.isProcessing) {
        this.queue.push(request);
        console.log(`🎵 Solicitud de música de ${username} agregada a la cola. Cola actual: ${this.queue.length}`);
        // No resolver inmediatamente, dejar que se procese
        return;
      }

      this.processRequest(request);
    });
  }

  private async processRequest(request: MusicRequest): Promise<void> {
    const { query, username, resolve, reject } = request;
    
    try {
      this.isProcessing = true;
      console.log(`🎵 [INICIO] Procesando música para ${username}: "${query}"`);

      // Buscar video en YouTube
      console.log(`🔍 [BUSQUEDA] Buscando en YouTube: "${query}"`);
      const searchResults = await ytsr(query, { limit: 1 });
      
      if (!searchResults || !searchResults.items || searchResults.items.length === 0) {
        throw new Error('No se encontraron resultados en YouTube');
      }

      const video = searchResults.items[0] as ytsr.Video;
      if (!video || video.type !== 'video') {
        throw new Error('No se encontró un video válido');
      }

      console.log(`� [VIDEO] Encontrado: "${video.title}" - ${video.url}`);

      // Verificar que el video esté disponible para ytdl
      if (!ytdl.validateURL(video.url)) {
        throw new Error('URL de video no válida para descarga');
      }

      // Obtener información del video
      const videoInfo = await ytdl.getInfo(video.url);
      console.log(`� [INFO] Video: ${videoInfo.videoDetails.title} - ${videoInfo.videoDetails.lengthSeconds}s`);

      // Verificar duración del video (máximo 10 minutos = 600 segundos)
      const durationSeconds = parseInt(videoInfo.videoDetails.lengthSeconds);
      const maxDurationSeconds = 10 * 60; // 10 minutos
      
      if (durationSeconds > maxDurationSeconds) {
        const durationMinutes = Math.round(durationSeconds / 60 * 10) / 10; // Redondear a 1 decimal
        const maxMinutes = maxDurationSeconds / 60;
        throw new Error(`El video es demasiado largo (${durationMinutes} min). La duración máxima permitida es ${maxMinutes} minutos.`);
      }

      console.log(`✅ [DURACION] Video dentro del límite: ${Math.round(durationSeconds / 60 * 10) / 10} min (máx: ${maxDurationSeconds / 60} min)`);

      // Configurar opciones de descarga para audio de alta calidad
      const downloadOptions: ytdl.downloadOptions = {
        quality: 'highestaudio',
        filter: 'audioonly',
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        }
      };

      console.log(`� [DESCARGA] Descargando audio...`);
      
      // Crear stream de descarga
      const audioStream = ytdl(video.url, downloadOptions);
      
      // Convertir a MP3 usando ffmpeg
      console.log(`� [CONVERSION] Convirtiendo a MP3...`);
      const mp3Buffer = await this.convertToMp3(audioStream);
      
      if (!mp3Buffer || mp3Buffer.length === 0) {
        throw new Error('Error en la conversión a MP3');
      }

      console.log(`📥 [PREPARADO] Audio MP3 preparado - Tamaño: ${mp3Buffer.length} bytes`);

      // Subir usando el servicio configurado
      console.log(`📤 [UPLOAD] Iniciando subida a ${this.uploadService}...`);
      const audioUrl = this.uploadService === 'litterbox' 
        ? await this.uploadToLitterbox(mp3Buffer, `${videoInfo.videoDetails.title}.mp3`)
        : await this.uploadToCatbox(mp3Buffer, `${videoInfo.videoDetails.title}.mp3`);
      
      // Crear mensaje con formato de audio
      const serviceInfo = this.uploadService === 'litterbox' 
        ? `📦 _Archivo temporal (${this.litterboxExpiry})_`
        : `📦 _Archivo permanente_`;
      
      const finalResult = `🎵 **${videoInfo.videoDetails.title}**\n[audio]${audioUrl}[/audio]\n_Solicitado por ${username}_ • ${serviceInfo}`;
      
      console.log(`✅ [ÉXITO] Música procesada exitosamente para ${username}`);
      resolve(finalResult);

    } catch (error) {
      console.error(`❌ [ERROR] Error procesando música para ${username}:`, error);
      if (error instanceof Error) {
        console.error(`❌ [ERROR] Stack trace:`, error.stack);
      }
      
      // Mensaje de error más específico según el servicio
      const serviceText = this.uploadService === 'litterbox' ? 'Litterbox (temporal)' : 'Catbox (permanente)';
      reject(new Error(`No se pudo procesar la música "${query}" usando ${serviceText}. Intenta con otro término de búsqueda.`));
    } finally {
      this.isProcessing = false;
      console.log(`🔄 [FINAL] Procesamiento terminado, procesando siguiente en cola...`);
      
      // Procesar siguiente en la cola
      const next = this.queue.shift();
      if (next) {
        console.log(`🔄 [COLA] Procesando siguiente solicitud en 1 segundo...`);
        setTimeout(() => this.processRequest(next), 1000); // Pequeño delay entre solicitudes
      } else {
        console.log(`🔄 [COLA] No hay más solicitudes en cola`);
      }
    }
  }

  /**
   * Convierte un stream de audio a MP3 usando ffmpeg
   * @param audioStream Stream de audio de entrada
   * @returns Buffer con el audio convertido a MP3
   */
  private convertToMp3(audioStream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      
      const ffmpegCommand = ffmpeg(audioStream)
        .audioCodec('libmp3lame')
        .audioBitrate(128)
        .audioChannels(2)
        .audioFrequency(44100)
        .format('mp3')
        .on('start', (commandLine) => {
          console.log(`🔄 [FFMPEG] Comando: ${commandLine}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`🔄 [FFMPEG] Progreso: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log(`✅ [FFMPEG] Conversión completada`);
          const buffer = Buffer.concat(chunks);
          resolve(buffer);
        })
        .on('error', (error) => {
          console.error(`❌ [FFMPEG] Error en conversión:`, error);
          reject(error);
        });

      // Capturar la salida como stream
      const ffmpegStream = ffmpegCommand.pipe();
      
      ffmpegStream.on('data', (chunk) => {
        chunks.push(chunk);
      });

      ffmpegStream.on('error', (error) => {
        console.error(`❌ [FFMPEG] Error en stream:`, error);
        reject(error);
      });
    });
  }

  /**
   * Convierte un stream a buffer
   * @param stream Stream de datos
   * @returns Buffer con los datos del stream
   */
  private streamToBuffer(stream: Stream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      
      stream.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      stream.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
      
      stream.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Sube un archivo a catbox.moe
   * @param buffer Buffer del archivo
   * @param filename Nombre del archivo
   * @returns URL del archivo subido
   */
  private async uploadToCatbox(buffer: Buffer, filename: string): Promise<string> {
    try {
      console.log(`📤 Subiendo "${filename}" a catbox.moe...`);
      console.log(`📤 Buffer size: ${buffer.length} bytes`);
      console.log(`📤 Buffer type: ${typeof buffer}`);
      console.log(`📤 Is Buffer: ${Buffer.isBuffer(buffer)}`);
      
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error(`Buffer inválido: tipo=${typeof buffer}, longitud=${buffer?.length}, esBuffer=${Buffer.isBuffer(buffer)}`);
      }
      
      const form = new FormData();
      form.append('reqtype', 'fileupload');
      
      // Usar el buffer directamente con filename como opciones
      form.append('fileToUpload', buffer, {
        filename: filename.replace(/[^a-zA-Z0-9.-]/g, '_'), // Sanitizar filename
        contentType: 'audio/mpeg',
        knownLength: buffer.length
      });

      console.log(`📤 FormData headers:`, form.getHeaders());

      // Añadir timeout y configuración de conexión
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 segundos timeout

      try {
        const response = await fetch('https://catbox.moe/user/api.php', {
          method: 'POST',
          body: form,
          headers: {
            ...form.getHeaders(),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: controller.signal,
          timeout: 30000
        });

        clearTimeout(timeoutId);
        console.log(`📤 Response status: ${response.status}`);

        if (!response.ok) {
          const errorText = await response.text();
          console.log(`📤 Error response text: "${errorText}"`);
          throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
        }

        const result = await response.text();
        console.log(`📤 Response text: "${result}"`);
        
        if (result.startsWith('https://files.catbox.moe/')) {
          console.log(`✅ Archivo subido exitosamente: ${result}`);
          return result.trim();
        } else {
          throw new Error(`Respuesta inesperada de catbox.moe: ${result}`);
        }
      } catch (fetchError) {
        clearTimeout(timeoutId);
        throw fetchError;
      }

    } catch (error) {
      console.error('❌ Error subiendo a catbox.moe:', error);
      
      // Intentar método alternativo si el principal falla
      if (error instanceof Error && (error.message.includes('ECONNRESET') || error.message.includes('socket hang up'))) {
        console.log('🔄 Intentando método alternativo de subida...');
        return await this.uploadToCatboxAlternative(buffer, filename);
      }
      
      throw new Error('No se pudo subir el archivo de audio');
    }
  }

  /**
   * Método alternativo de subida usando un enfoque diferente
   */
  private async uploadToCatboxAlternative(buffer: Buffer, filename: string): Promise<string> {
    try {
      console.log(`📤 [ALT] Intentando subida alternativa...`);
      
      // Crear form-data de manera más simple
      const FormData = require('form-data');
      const form = new FormData();
      
      form.append('reqtype', 'fileupload');
      form.append('fileToUpload', buffer, {
        filename: filename.replace(/[^a-zA-Z0-9.-]/g, '_'),
        contentType: 'audio/mpeg'
      });

      const response = await fetch('https://catbox.moe/user/api.php', {
        method: 'POST',
        body: form,
        headers: form.getHeaders()
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.text();
      
      if (result.startsWith('https://files.catbox.moe/')) {
        console.log(`✅ [ALT] Archivo subido exitosamente: ${result}`);
        return result.trim();
      } else {
        throw new Error(`Respuesta inesperada de catbox.moe: ${result}`);
      }

    } catch (error) {
      console.error('❌ [ALT] Error en método alternativo:', error);
      throw new Error('Todos los métodos de subida fallaron');
    }
  }

  /**
   * Sube un archivo a litterbox.catbox.moe (temporal)
   * @param buffer Buffer del archivo
   * @param filename Nombre del archivo
   * @returns URL del archivo subido
   */
  private async uploadToLitterbox(buffer: Buffer, filename: string): Promise<string> {
    try {
      console.log(`📤 [LITTERBOX] Subiendo "${filename}" a litterbox.catbox.moe...`);
      console.log(`📤 [LITTERBOX] Buffer size: ${buffer.length} bytes`);
      console.log(`📤 [LITTERBOX] Expiración: ${this.litterboxExpiry}`);
      
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error(`Buffer inválido: tipo=${typeof buffer}, longitud=${buffer?.length}, esBuffer=${Buffer.isBuffer(buffer)}`);
      }
      
      const form = new FormData();
      form.append('time', this.litterboxExpiry);
      form.append('fileNameLength', '16'); // Longitud por defecto
      form.append('reqtype', 'fileupload');
      
      // Usar el buffer directamente con filename como opciones
      form.append('fileToUpload', buffer, {
        filename: filename.replace(/[^a-zA-Z0-9.-]/g, '_'), // Sanitizar filename
        contentType: 'audio/mpeg',
        knownLength: buffer.length
      });

      console.log(`📤 [LITTERBOX] FormData headers:`, form.getHeaders());

      // Añadir timeout y configuración de conexión
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 segundos timeout

      try {
        const response = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
          method: 'POST',
          body: form,
          headers: {
            ...form.getHeaders(),
            'accept': 'application/json',
            'accept-language': 'es-419,es;q=0.9,es-ES;q=0.8,en;q=0.7,en-GB;q=0.6,en-US;q=0.5',
            'cache-control': 'no-cache',
            'origin': 'https://litterbox.catbox.moe',
            'referer': 'https://litterbox.catbox.moe/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
            'x-requested-with': 'XMLHttpRequest'
          },
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        console.log(`📤 [LITTERBOX] Response status: ${response.status}`);

        if (!response.ok) {
          const errorText = await response.text();
          console.log(`📤 [LITTERBOX] Error response text: "${errorText}"`);
          throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
        }

        const result = await response.text();
        console.log(`📤 [LITTERBOX] Response text: "${result}"`);
        
        if (result.startsWith('https://litter.catbox.moe/')) {
          console.log(`✅ [LITTERBOX] Archivo subido exitosamente: ${result}`);
          console.log(`⏰ [LITTERBOX] El archivo expirará en: ${this.litterboxExpiry}`);
          return result.trim();
        } else {
          throw new Error(`Respuesta inesperada de litterbox.catbox.moe: ${result}`);
        }
      } catch (fetchError) {
        clearTimeout(timeoutId);
        throw fetchError;
      }

    } catch (error) {
      console.error('❌ [LITTERBOX] Error subiendo a litterbox.catbox.moe:', error);
      
      // Fallback a catbox si litterbox falla
      console.log('🔄 [FALLBACK] Intentando con catbox.moe como respaldo...');
      return await this.uploadToCatbox(buffer, filename);
    }
  }

  /**
   * Obtiene el estado actual de la cola
   * @returns Información sobre la cola de procesamiento
   */
  getQueueStatus(): { isProcessing: boolean; queueLength: number } {
    return {
      isProcessing: this.isProcessing,
      queueLength: this.queue.length
    };
  }

  private waitForProcessing(): Promise<void> {
    return new Promise((resolve) => {
      const checkProcessing = () => {
        if (!this.isProcessing) {
          resolve();
        } else {
          setTimeout(checkProcessing, 1000);
        }
      };

      checkProcessing();
    });
  }
}
