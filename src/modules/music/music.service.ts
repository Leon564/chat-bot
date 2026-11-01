import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Client, Quality, Ytdl } from "@distube/ytdl-core";
import * as ffmpeg from "fluent-ffmpeg";
import * as ffmpegPath from "@ffmpeg-installer/ffmpeg";
import * as ytsr from "ytsr";
import { Stream, Readable } from "stream";
import { pipeline } from "stream/promises";
import * as fs from "fs";
import * as path from "path";
import * as FormData from "form-data";
import fetch from "node-fetch";
import * as he from "he";
import YTDlpWrap from "yt-dlp-wrap";
import {
  MusicRequest,
  MusicStage,
  MusicProgress,
  YouTubeCookie,
  QueueStatus,
  MusicResult,
  TrackMeta,
} from "../../common/interfaces";
import { GraphCacheService } from "../graph/graph-cache.service";
import { GraphService } from "../graph/graph.service";
import { Semaphore } from "./semaphore";
import { pickSong, pickVideo } from "./video-picker";
import {
  YOUTUBE_MUSIC_SEARCH_URL,
  buildSongSearchBody,
  parseSongResults,
} from "./youtube-music-search";

// Configurar ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath.path);

@Injectable()
export class MusicService {
  /**
   * Pipeline por etapas. Antes había un único `while` serial: buscar →
   * descargar → transcodificar → subir, y recién ahí empezaba el siguiente
   * pedido. Con una canción no se notaba; con N la espera era N veces el
   * pipeline entero, porque ninguna etapa se superponía con otra.
   *
   * Ahora cada pedido avanza por su cuenta y cada etapa tiene su propio
   * límite, elegido según qué recurso satura:
   *
   *  - BÚSQUEDA (YouTube Music / ytsr): sólo latencia de red y unos KB de metadata. Varias en
   *    paralelo no cuestan nada y sacan la latencia del camino crítico.
   *  - DESCARGA + ffmpeg: CPU y disco. Se mantiene en 1 a propósito — es la
   *    etapa que de verdad hay que serializar para no reventar la RAM ni
   *    poner a competir dos ffmpeg por el CPU.
   *  - SUBIDA: puro I/O de red, el proceso está ocioso esperando. Dejarla en
   *    paralelo con la descarga del siguiente tema es de donde sale la mayor
   *    parte de la mejora: la canción 2 se descarga mientras la 1 sube.
   */
  private readonly searchSem = new Semaphore(3);
  private readonly downloadSem = new Semaphore(1);
  private readonly uploadSem = new Semaphore(2);

  /**
   * Pedidos vivos, en orden de llegada. Reemplaza al array `queue` que antes
   * era a la vez cola de trabajo y fuente del estado; ahora el trabajo lo
   * agendan los semáforos y esto sirve sólo para reportar posición y estado.
   * Se saca la entrada en un `finally`, así un pedido que falla no queda
   * contando para siempre en la posición de los demás.
   */
  private readonly pending: MusicRequest[] = [];

  /**
   * Turno de entrada a la descarga, en orden de llegada. La búsqueda corre
   * de a 3 en paralelo, así que sin esto el orden en que los pedidos llegan
   * al `downloadSem` es el orden en que TERMINAN de buscar: una búsqueda
   * lenta dejaba que un pedido posterior se le colara en la descarga. Cada
   * pedido espera el turno del anterior antes de pedir su permiso y suelta
   * el suyo recién después de haberse formado en el semáforo.
   */
  private downloadTurn: Promise<void> = Promise.resolve();

  private uploadService: "catbox" | "litterbox" | "nullpointer" | "filegarden" | "uguu";
  private litterboxExpiry: string;
  private youtubeCookies: any | null; // Cambiar de string a any para el jar de cookies
  // Una sola instancia: guarda la sesión que YouTube le da (visitor data, player).
  private readonly yt: Ytdl;
  // VisionOS, el primer cliente por defecto, no ofrece formatos con audio y
  // video juntos; estos dos sí traen el itag 18, que es el que se sube sin ffmpeg.
  private readonly ytMuxed: Ytdl;
  private ytdlp: YTDlpWrap | null = null;
  private ytdlpAvailable: boolean = false;
  // testConnectivity() pinged dns.google before every upload, which added a
  // 5s round-trip per file even when the network was clearly fine (we'd just
  // succeeded a previous upload seconds earlier). Cache the OK result for
  // CONNECTIVITY_TTL_MS so back-to-back queue items skip the re-check.
  private lastConnectivityOk: number = 0;
  private readonly CONNECTIVITY_TTL_MS = 60_000;
  // Timeout del HEAD que verifica si una URL cacheada sigue viva. Corto a
  // propósito: este chequeo corre ANTES de encolar, así que un host que
  // nunca responde cabecera no puede sumarle minutos a un camino que antes
  // arrancaba de inmediato.
  private readonly CACHED_URL_HEAD_TIMEOUT_MS = 4_000;
  // Corto porque si vence el pedido sigue por YouTube: es latencia que se suma
  // a la búsqueda normal, no un intento único.
  private readonly YOUTUBE_MUSIC_SEARCH_TIMEOUT_MS = 5_000;
  // Dedup de pedidos en vuelo: si dos solicitudes idénticas (misma query
  // normalizada) llegan mientras la primera todavía está resolviéndose (cache
  // miss + pipeline en curso), la segunda no encola un item nuevo — comparte
  // la promesa de la PISTA (no del MusicResult completo, que trae el
  // <@usuario> del que la disparó) y arma su propio texto al resolver.
  private readonly inFlightTrackRequests = new Map<string, Promise<TrackMeta>>();

  constructor(
    private readonly configService: ConfigService,
    private readonly graphCacheService: GraphCacheService,
    private readonly graphService: GraphService,
  ) {
    // Configurar servicio de subida desde variables de entorno
    this.uploadService =
      (this.configService.get<string>("music.uploadService") as
        | "catbox"
        | "litterbox"
        | "nullpointer"
        | "filegarden") || "catbox";
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

    const cookie: string | undefined = this.youtubeCookies
      ?.map((c: YouTubeCookie) => `${c.name}=${c.value}`)
      .join("; ");
    this.yt = new Ytdl(cookie ? { cookie } : {});
    this.ytMuxed = new Ytdl({
      clients: [Client.WebEmbedded, Client.Tv],
      ...(cookie ? { cookie } : {}),
    });

    // Inicializar yt-dlp de forma segura
    this.initializeYtDlp();
  }

  private async initializeYtDlp(): Promise<void> {
    try {
      this.ytdlp = new YTDlpWrap();
      console.log(`🔧 [YT-DLP] Inicializado como fallback`);
      
      // Verificar disponibilidad de forma asíncrona sin bloquear
      this.ensureYtDlpAvailable().then(() => {
        this.ytdlpAvailable = true;
        console.log(`✅ [YT-DLP] yt-dlp está listo para usar`);
      }).catch(error => {
        this.ytdlpAvailable = false;
        console.warn(`⚠️ [YT-DLP] yt-dlp no está disponible, solo se usará ytdl-core:`, error instanceof Error ? error.message : error);
      });
    } catch (error) {
      console.warn(`⚠️ [YT-DLP] Error inicializando yt-dlp:`, error instanceof Error ? error.message : error);
      this.ytdlp = null;
      this.ytdlpAvailable = false;
    }
  }

  private async ensureYtDlpAvailable(): Promise<void> {
    if (!this.ytdlp) {
      throw new Error('yt-dlp no está inicializado');
    }

    try {
      // Verificar si yt-dlp está disponible con timeout
      await this.safeYtDlpExec(['--version'], 10000);
      console.log(`✅ [YT-DLP] yt-dlp está disponible`);
    } catch (error) {
      console.log(`📥 [YT-DLP] yt-dlp no encontrado, intentando descarga automática...`);
      try {
        // Descargar yt-dlp automáticamente
        await YTDlpWrap.downloadFromGithub();
        console.log(`✅ [YT-DLP] yt-dlp descargado exitosamente`);
        
        // Verificar que funcione después de la descarga
        await this.safeYtDlpExec(['--version'], 10000);
        console.log(`✅ [YT-DLP] yt-dlp verificado después de descarga`);
      } catch (downloadError) {
        console.error(`❌ [YT-DLP] Error descargando o verificando yt-dlp:`, downloadError);
        throw new Error(`No se pudo configurar yt-dlp: ${downloadError instanceof Error ? downloadError.message : downloadError}`);
      }
    }
  }

  /**
   * Ejecuta comando yt-dlp de forma segura con timeout
   */
  private async safeYtDlpExec(args: string[], timeoutMs: number = 30000): Promise<void> {
    if (!this.ytdlp) {
      throw new Error('yt-dlp no está inicializado');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`yt-dlp timeout después de ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const ytdlpProcess = this.ytdlp!.exec(args);
        
        ytdlpProcess.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`yt-dlp salió con código ${code}`));
          }
        });

        ytdlpProcess.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  private async isYtDlpAvailable(): Promise<boolean> {
    // Si ya sabemos el estado, devolverlo directamente
    if (this.ytdlpAvailable !== undefined) {
      return this.ytdlpAvailable;
    }

    // Si yt-dlp no está inicializado, no está disponible
    if (!this.ytdlp) {
      this.ytdlpAvailable = false;
      return false;
    }

    try {
      await this.safeYtDlpExec(['--version'], 5000);
      this.ytdlpAvailable = true;
      return true;
    } catch (error) {
      this.ytdlpAvailable = false;
      console.warn(`⚠️ [YT-DLP] yt-dlp no responde:`, error instanceof Error ? error.message : error);
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
   * True only for explicit !video commands. We deliberately don't match
   * natural-language phrases here to avoid misfiring on casual conversation;
   * users who want a video should opt in by typing the prefix.
   */
  static isVideoRequest(message: string): boolean {
    if (!message || typeof message !== 'string') return false;
    return /^\s*!video\s+.+/i.test(he.decode(message));
  }

  /** Strips the !video prefix and returns the remaining query. */
  static extractVideoQuery(message: string): string {
    if (!message || typeof message !== 'string') return '';
    const m = he.decode(message).match(/^\s*!video\s+(.+)/i);
    return m ? m[1].trim() : '';
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
   * Procesa una solicitud de música. Antes de encolar, intenta servir desde
   * el grafo (una subida ya hecha y todavía viva) y deduplica pedidos
   * idénticos que ya están en vuelo — un acierto en cualquiera de los dos
   * casos saltea búsqueda, descarga, transcodificación y subida por completo.
   */
  async processMusic(
    query: string,
    username: string,
    onProgress?: (update: MusicProgress) => void,
  ): Promise<MusicResult> {
    const cachedResult = await this.tryServeFromCache(query, username);
    if (cachedResult) {
      return cachedResult;
    }

    const normalizedQuery = this.graphService.normalizeKey(query);

    if (normalizedQuery) {
      const inFlight = this.inFlightTrackRequests.get(normalizedQuery);
      if (inFlight) {
        console.log(
          `🎵 [DEDUP] Pedido idéntico en vuelo para "${query}" — reutilizando sin encolar de nuevo`
        );
        const track = await inFlight;
        return this.buildResultFromTrack(track, username);
      }
    }

    const pipelinePromise = this.enqueueMusicRequest(query, username, onProgress);

    if (!normalizedQuery) {
      return pipelinePromise;
    }

    // Se comparte la promesa de la PISTA, no la del MusicResult: el texto
    // trae el <@usuario> del que disparó el pipeline y no debe filtrarse a
    // los demás llamadores deduplicados.
    const trackPromise = pipelinePromise.then((result) => {
      if (!result.track) {
        throw new Error(result.text);
      }
      return result.track;
    });
    // Sin este catch, un pipeline que falla dispara un unhandledRejection acá
    // (nadie más "atrapa" trackPromise salvo que haya llegado un pedido
    // duplicado) — el rechazo real lo sigue viendo quien espera
    // `pipelinePromise` más abajo.
    trackPromise.catch(() => {});

    this.inFlightTrackRequests.set(normalizedQuery, trackPromise);
    const clearInFlight = () => {
      if (this.inFlightTrackRequests.get(normalizedQuery) === trackPromise) {
        this.inFlightTrackRequests.delete(normalizedQuery);
      }
    };
    trackPromise.then(clearInFlight, clearInFlight);

    return pipelinePromise;
  }

  /**
   * Busca la pista en el grafo (Task 1). Un acierto no es automáticamente
   * servible: la URL subida puede haber muerto (litterbox venció, o incluso
   * un catbox/filegarden eliminado a mano), así que se verifica con un HEAD
   * antes de devolverla.
   *
   * Sólo un 404/410 explícito ("esto ya no existe") invalida la entrada.
   * Cualquier otra cosa — timeout, error de red, un 403/405 de un CDN que
   * rechaza HEAD, o directamente que `fetch` no exista — es "no sé", no "está
   * muerta": se cae al pipeline normal SIN borrar el dato. Invalidar ante la
   * duda es peor que no cachear: un blip de red borraría una URL perfectamente
   * viva y obligaría a re-subir el archivo la próxima vez.
   *
   * Cualquier fallo del propio caché (Mongo caído, etc.) se traga acá y
   * también cae al pipeline normal, nunca lanza.
   */
  private async tryServeFromCache(
    query: string,
    username: string,
  ): Promise<MusicResult | null> {
    let cached: TrackMeta | null;
    try {
      cached = await this.graphCacheService.findTrack(query);
    } catch (err) {
      console.warn(
        `⚠️ [CACHE] findTrack falló, se sigue sin caché: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
    if (!cached) return null;

    const status = await this.checkCachedUrl(cached.uploadUrl);

    if (status === "dead") {
      console.log(`🗑️ [CACHE] URL cacheada muerta (404/410) para "${query}", invalidando y siguiendo al pipeline`);
      await this.graphCacheService.invalidateTrack(query).catch(() => {});
      return null;
    }

    if (status === "unknown") {
      console.log(`❓ [CACHE] No se pudo confirmar la URL cacheada para "${query}" (timeout/error/status ambiguo), sin invalidar — siguiendo al pipeline`);
      return null;
    }

    console.log(`✨ [CACHE] Sirviendo "${query}" desde el grafo, sin pipeline`);
    return this.buildResultFromTrack(cached, username);
  }

  /**
   * HEAD contra la URL cacheada usando el mismo `node-fetch` que el resto del
   * archivo (no `globalThis.fetch`, que es una dependencia implícita de
   * Node 18+ que ni declara `package.json`), con un timeout corto: un host
   * que acepta la conexión y nunca responde cabecera puede colgar varios
   * minutos, y este chequeo corre ANTES de encolar — el usuario ya vio
   * "Buscando…" y el pedido ni siquiera entró a la cola.
   */
  private async checkCachedUrl(url: string): Promise<"alive" | "dead" | "unknown"> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.CACHED_URL_HEAD_TIMEOUT_MS);

    try {
      const head = await fetch(url, { method: "HEAD", signal: controller.signal });
      if (head.status === 404 || head.status === 410) return "dead";
      if (head.ok) return "alive";
      // Cualquier otro status (403, 405, 500...) no confirma ni desmiente
      // que el archivo siga vivo.
      return "unknown";
    } catch (err) {
      console.warn(
        `⚠️ [CACHE] HEAD a "${url}" falló o hizo timeout: ${err instanceof Error ? err.message : err}`
      );
      return "unknown";
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Arma el MusicResult exactamente con el mismo formato que
   * `processSingleMusicRequest`, reusando `buildAudioBBCode`, para que el
   * texto sea idéntico venga del caché o del pipeline. Es el punto donde
   * cada llamador deduplicado inserta su propio nombre — la pista compartida
   * no lo trae.
   */
  private buildResultFromTrack(track: TrackMeta, username: string): MusicResult {
    const videoLike = {
      title: track.title,
      author: track.artist ? { name: track.artist } : undefined,
      bestThumbnail: track.thumb ? { url: track.thumb } : undefined,
    };
    const audioTag = this.buildAudioBBCode(track.uploadUrl, videoLike);
    return {
      text: `🎵 <@${username}> Aquí tienes "${track.title}": ${audioTag}`,
      track,
    };
  }

  /**
   * Empuja la solicitud a la cola FIFO real y dispara `processQueue` si
   * estaba ociosa. Extraído de lo que antes era el cuerpo entero de
   * `processMusic` para que sea un punto de entrada único al pipeline
   * pesado — el que se dobla en los tests.
   */
  private enqueueMusicRequest(
    query: string,
    username: string,
    onProgress?: (update: MusicProgress) => void,
  ): Promise<MusicResult> {
    return this.runPipeline({ query, username, kind: 'audio', onProgress });
  }

  /**
   * Procesa una solicitud de video (opt-in via VIDEO_ENABLED). Comparte las
   * mismas etapas y semáforos que el audio: la descarga/transcodificación
   * sigue siendo de a una, así que un video pesado nunca corre su ffmpeg en
   * paralelo con el de una canción.
   */
  async processVideo(
    query: string,
    username: string,
    onProgress?: (update: MusicProgress) => void,
  ): Promise<MusicResult> {
    return this.runPipeline({ query, username, kind: 'video', onProgress });
  }

  /**
   * Obtiene el estado de la cola de procesamiento, desglosado por etapa.
   * `isProcessing` se mantiene por compatibilidad con el comando de debug.
   */
  getQueueStatus(): QueueStatus {
    const count = (stage: MusicStage) =>
      this.pending.filter((r) => r.stage === stage).length;
    return {
      isProcessing: this.pending.length > 0,
      queueLength: this.pending.length,
      searching: count('searching'),
      downloading: count('downloading'),
      uploading: count('uploading'),
    };
  }

  /**
   * Lleva un pedido por las tres etapas. Cada `await sem.run(...)` es a la
   * vez el turno y el límite de concurrencia de esa etapa, así que el código
   * se lee secuencialmente aunque varios pedidos lo estén recorriendo a la
   * vez en puntos distintos.
   */
  private async runPipeline(
    spec: Pick<MusicRequest, 'query' | 'username' | 'kind' | 'onProgress'>,
  ): Promise<MusicResult> {
    const request: MusicRequest = {
      ...spec,
      stage: 'queued',
      resolve: () => {},
      reject: () => {},
    };
    this.pending.push(request);

    const prevTurn = this.downloadTurn;
    let releaseTurn!: () => void;
    this.downloadTurn = new Promise<void>((resolve) => (releaseTurn = resolve));
    let turnReleased = false;

    const isVideo = request.kind === 'video';
    const tag = isVideo ? '🎬' : '🎵';
    console.log(
      `${tag} [QUEUE] "${request.query}" encolada. Pendientes: ${this.pending.length}`,
    );

    try {
      // ── Etapa 1: búsqueda ────────────────────────────────────────────────
      this.setStage(request, 'searching');
      const video = await this.searchSem.run(() =>
        this.findVideo(request.query, isVideo),
      );
      console.log(`🎯 [FOUND] "${video.title}" - ${video.url}`);

      // ── Etapa 2: descarga + transcodificación (serializada) ──────────────
      await prevTurn;
      this.setStage(request, 'downloading');
      // `run` se forma en el semáforo de forma sincrónica, así que al soltar
      // el turno en la línea siguiente este pedido ya está en la fila.
      const downloadPromise = this.downloadSem.run(() =>
        isVideo
          ? this.prepareVideoFile(video, request.username)
          : this.prepareAudioFile(video, request.username),
      );
      turnReleased = true;
      releaseTurn();
      const prepared = await downloadPromise;

      // ── Etapa 3: subida (se superpone con la descarga del siguiente) ─────
      this.setStage(request, 'uploading');
      return await this.uploadSem.run(() =>
        this.publishPreparedFile(prepared, video, request.username, isVideo),
      );
    } catch (error) {
      console.error(`${tag} [ERROR] Error procesando "${request.query}":`, error);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      // Si falló antes de formarse (búsqueda sin resultados, ytsr caído), el
      // turno se pasa recién cuando le toque: soltarlo ya dejaría al
      // siguiente adelantarse a los que siguen buscando delante suyo.
      if (!turnReleased) void prevTurn.then(releaseTurn);
      const idx = this.pending.indexOf(request);
      if (idx !== -1) this.pending.splice(idx, 1);
    }
  }

  /**
   * Marca la etapa y le avisa al usuario. La posición que se reporta es
   * cuántos pedidos tiene por delante en la etapa pesada (la descarga): es
   * el único número que de verdad predice la espera, porque búsqueda y
   * subida corren en paralelo.
   */
  private setStage(request: MusicRequest, stage: MusicStage): void {
    request.stage = stage;
    if (!request.onProgress) return;

    // `pending` está en orden de llegada y la descarga respeta ese orden
    // (`downloadTurn`), así que va adelante todo el que llegó antes y todavía
    // no la soltó — incluido quien sigue buscando. Los que están en
    // 'uploading' no demoran a nadie: contarlos le anunciaba "hay 1 pedido
    // antes que el tuyo" a quien iba a empezar a descargar en el acto.
    const ahead = this.pending
      .slice(0, this.pending.indexOf(request))
      .filter((r) => r.stage !== 'uploading').length;

    const text =
      stage === 'searching' && ahead > 0
        ? `⏳ Hay ${ahead} ${ahead === 1 ? 'pedido' : 'pedidos'} antes que el tuyo — sos el #${ahead + 1} en la cola.`
        : stage === 'downloading'
          ? `⬇️ Descargando "${request.query}"…`
          : stage === 'uploading'
            ? `☁️ Subiendo "${request.query}"…`
            : '';

    if (!text) return;
    try {
      request.onProgress({ stage, position: ahead, text });
    } catch {
      // El feedback es best-effort: nunca debe tumbar el pipeline.
    }
  }

  /**
   * Los pedidos de audio prueban primero el catálogo de YouTube Music y usan
   * YouTube cuando ahí no aparece lo pedido. Los pedidos de video van directo a
   * YouTube, porque lo que quieren es justamente el video.
   */
  private async findVideo(query: string, isVideo: boolean): Promise<any> {
    if (!isVideo) {
      const song = await this.findSong(query);
      if (song) return song;
    }
    const videos = await this.searchYouTube(query);
    if (videos.length === 0) {
      throw new Error(`No se encontraron resultados para "${query}"`);
    }
    return this.chooseVideo(videos, query, isVideo);
  }

  /** Nunca lanza: si YouTube Music falla, el pedido sigue por YouTube. */
  private async findSong(query: string): Promise<any | null> {
    const maxMinutes =
      this.configService.get<number>('music.maxDurationMinutes') || 8;
    try {
      const song = pickSong(await this.searchYouTubeMusic(query), query, maxMinutes);
      if (!song) {
        console.log(`🔎 [YT-MUSIC] Sin coincidencia para "${query}", se busca en YouTube`);
      }
      return song;
    } catch (error) {
      console.warn(
        `⚠️ [YT-MUSIC] Búsqueda fallida, se busca en YouTube:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  private async searchYouTubeMusic(query: string): Promise<any[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.YOUTUBE_MUSIC_SEARCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(YOUTUBE_MUSIC_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.getRandomUserAgent(),
          Origin: 'https://music.youtube.com',
          Referer: 'https://music.youtube.com/',
        },
        body: JSON.stringify(buildSongSearchBody(query)),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseSongResults(await response.json());
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Elige qué resultado descargar (ver `video-picker.ts`): descarta los que
   * pasan el límite de duración buscando el siguiente que siga siendo la
   * misma canción, y en audio prioriza audio oficial / lyrics sobre el
   * videoclip. Si todos los relevantes son demasiado largos lanza el mismo
   * error que `assertDurationWithin`.
   */
  private chooseVideo(videos: any[], query: string, isVideo: boolean): any {
    const maxMinutes = isVideo
      ? this.configService.get<number>('video.maxDurationMinutes') || 5
      : this.configService.get<number>('music.maxDurationMinutes') || 8;
    const { video, tooLong } = pickVideo(videos, query, {
      maxMinutes,
      preferAudio: !isVideo,
    });
    if (video) {
      if (video !== videos[0]) {
        console.log(
          `🔀 [PICK] Se prefirió "${video.title}" (${video.duration ?? '?'}) sobre el primer resultado "${videos[0]?.title}" (${videos[0]?.duration ?? '?'})`,
        );
      }
      return video;
    }
    if (tooLong) this.assertDurationWithin(tooLong, maxMinutes);
    throw new Error(`No se encontraron resultados para "${query}"`);
  }

  /**
   * Busca un query en YouTube y devuelve los items tipo "video". Helper
   * extraído para reutilizar entre el flujo de audio, el de video, y el
   * search-ahead que dispara processQueue antes de tocar al siguiente item.
   */
  private async searchYouTube(query: string): Promise<any[]> {
    // 10 y no 5: la elección de resultado necesita alternativas para cuando
    // el primero es demasiado largo o es el videoclip en vez del audio.
    const searchResults = await ytsr(query, {
      limit: 10,
      requestOptions: {
        maxRedirects: 10,
        maxRetries: 3,
        maxReconnects: 2,
        backoff: { inc: 500, max: 5000 },
        headers: { 'User-Agent': this.getRandomUserAgent() },
      },
    } as any);
    return searchResults.items.filter((item: any) => item.type === 'video');
  }

  /**
   * Resultado de la etapa pesada: un archivo ya listo en disco. Nunca se
   * devuelve el contenido en memoria — ese era el origen del pico de RAM.
   */
  private async prepareAudioFile(
    video: any,
    username: string,
  ): Promise<{ path: string }> {
    const maxDurationMinutes =
      this.configService.get<number>('music.maxDurationMinutes') || 8;
    this.assertDurationWithin(video, maxDurationMinutes);

    const outputPath = this.tempFilePath('music', username, 'mp3');

    // yt-dlp primero: resuelve PoToken, baja SÓLO el audio y ya entrega un
    // mp3 128K escrito en disco.
    if (await this.isYtDlpAvailable()) {
      try {
        await this.downloadAudioWithYtDlp(video.url, outputPath);
        console.log(
          `✅ [YT-DLP] Audio listo: ${this.fileSizeMb(outputPath)} MB (sin re-codificar)`,
        );
        return { path: outputPath };
      } catch (error) {
        console.warn(
          `⚠️ [YT-DLP] Falló, probando ytdl-core:`,
          error instanceof Error ? error.message : error,
        );
        this.safeUnlink(outputPath);
      }
    }

    // Fallback ytdl-core. Se baja directo a un archivo temporal y se
    // transcodifica desde disco: nada de Buffer.concat con la canción
    // entera (que además duplicaba el pico al concatenar los chunks).
    const rawPath = this.tempFilePath('raw', username, 'media');
    let lastError: unknown = null;

    // Dos intentos, no tres, y sin el backoff de 3s/6s/9s: la escalera vieja
    // podía quemar más de un minuto por canción antes de rendirse, y eso se
    // pagaba otra vez por cada pedido de la cola.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`⬇️ [YTDL-CORE] Intento ${attempt}/2 — ${video.url}`);
        await this.streamToFile(
          this.yt.download(video.url, {
            quality: Quality.HighestAudio,
            filter: { hasAudio: true, hasVideo: false },
          }),
          rawPath,
          60_000,
        );
        console.log(`✅ [YTDL-CORE] Descargado: ${this.fileSizeMb(rawPath)} MB`);

        await this.transcodeToMp3(rawPath, outputPath);
        this.safeUnlink(rawPath);
        return { path: outputPath };
      } catch (error) {
        lastError = error;
        this.safeUnlink(rawPath);
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`❌ [YTDL-CORE] Intento ${attempt} falló:`, msg);
        if (/too many redirects|status code: 403|sign in to confirm/i.test(msg)) {
          break;
        }
      }
    }

    this.safeUnlink(outputPath);
    throw new Error(
      `No se pudo descargar el audio con ningún método. Último error: ${
        lastError instanceof Error ? lastError.message : lastError
      }`,
    );
  }

  /**
   * Etapa pesada del camino de video: deja un mp4 listo en disco. Igual que
   * el audio, nunca pasa por un Buffer — antes se bajaba el mp4 entero a RAM
   * (hasta 5 minutos de video) sólo para escribirlo con writeFileSync.
   */
  private async prepareVideoFile(
    video: any,
    username: string,
  ): Promise<{ path: string }> {
    const maxDur = this.configService.get<number>('video.maxDurationMinutes') || 5;
    this.assertDurationWithin(video, maxDur);

    const outputPath = this.tempFilePath('video', username, 'mp4');
    let lastError: unknown = null;

    try {
      await this.streamToFile(
        this.ytMuxed.download(video.url, {
          quality: Quality.Highest,
          filter: (format) =>
            format.hasVideo &&
            format.hasAudio &&
            (format.container === 'mp4' || !format.container),
        }),
        outputPath,
        5 * 60 * 1000,
      );
      console.log(`✅ [VIDEO] ytdl-core OK: ${this.fileSizeMb(outputPath)} MB`);
      return { path: outputPath };
    } catch (error) {
      lastError = error;
      this.safeUnlink(outputPath);
      console.error(
        `❌ [VIDEO] ytdl-core falló:`,
        error instanceof Error ? error.message : error,
      );
    }

    if (!(await this.isYtDlpAvailable())) {
      throw new Error(
        `No se pudo descargar el video. ytdl-core falló: ${
          lastError instanceof Error ? lastError.message : lastError
        }. yt-dlp no está disponible.`,
      );
    }

    try {
      console.log(`🔄 [VIDEO] Probando yt-dlp como fallback`);
      await this.safeYtDlpExec(
        [
          video.url,
          '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
          '--merge-output-format', 'mp4',
          '-o', outputPath,
          '--no-playlist',
          '--quiet',
          '--no-warnings',
        ],
        5 * 60 * 1000,
      );
      if (!fs.existsSync(outputPath)) throw new Error('yt-dlp no produjo archivo');
      console.log(`✅ [VIDEO] yt-dlp OK: ${this.fileSizeMb(outputPath)} MB`);
      return { path: outputPath };
    } catch (ytdlpError) {
      this.safeUnlink(outputPath);
      throw new Error(
        `No se pudo descargar el video. ytdl-core: ${
          lastError instanceof Error ? lastError.message : lastError
        }. yt-dlp: ${ytdlpError instanceof Error ? ytdlpError.message : ytdlpError}`,
      );
    }
  }

  /**
   * Etapa 3, común a audio y video: sube el archivo ya preparado, lo borra y
   * arma el MusicResult. Es lo único que queda en el camino crítico una vez
   * liberado el semáforo de descarga, así que correrla en paralelo con la
   * descarga del siguiente pedido es seguro: sólo usa red y un descriptor.
   */
  private async publishPreparedFile(
    prepared: { path: string },
    video: any,
    username: string,
    isVideo: boolean,
  ): Promise<MusicResult> {
    const { path: filePath } = prepared;
    try {
      const uploadUrl = await this.uploadFile(filePath);
      console.log(`☁️ [UPLOAD] OK: ${uploadUrl}`);
      this.safeUnlink(filePath);

      const body = isVideo
        ? `[video]${uploadUrl}[/video]`
        : this.buildAudioBBCode(uploadUrl, video);

      return {
        text: `${isVideo ? '🎬' : '🎵'} <@${username}> Aquí tienes "${video.title}": ${body}`,
        track: {
          title: video.title,
          artist: video.author?.name ?? null,
          thumb: video.bestThumbnail?.url ?? null,
          youtubeUrl: video.url ?? null,
          uploadUrl,
          uploadService: this.serviceFromUploadUrl(uploadUrl),
        },
      };
    } catch (uploadError) {
      const msg =
        uploadError instanceof Error ? uploadError.message : String(uploadError);

      if (msg.includes('temporalmente no disponibles')) {
        console.log(`💾 [BACKUP] Manteniendo archivo local: ${filePath}`);
        return {
          text: `${isVideo ? '🎬' : '🎵'} <@${username}> "${video.title}" se procesó pero los servicios de subida están temporalmente no disponibles. Probá de nuevo en unos minutos.`,
          track: null,
        };
      }

      this.safeUnlink(filePath);
      throw uploadError;
    }
  }

  // ─── Utilidades de archivo/stream ──────────────────────────────────────────

  /** Valida la duración declarada por ytsr antes de gastar red y CPU. */
  private assertDurationWithin(video: any, maxMinutes: number): void {
    if (!video?.duration || typeof video.duration !== 'string') return;
    const minutes = this.parseDurationToMinutes(video.duration);
    console.log(
      `⏱️ [DURATION] ${video.duration} (${minutes} min) — límite ${maxMinutes} min`,
    );
    if (minutes > maxMinutes) {
      throw new Error(
        `El video es demasiado largo (${minutes} min). El límite es de ${maxMinutes} minutos.`,
      );
    }
  }

  /** Ruta temporal con el nombre de usuario saneado. Crea `temp/` si falta. */
  private tempFilePath(prefix: string, username: string, ext: string): string {
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const safeUser =
      username.replace(/[^\w\-_.]/g, '').substring(0, 20) || 'user';
    return path.join(
      tempDir,
      `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeUser}.${ext}`,
    );
  }

  private fileSizeMb(filePath: string): string {
    try {
      return (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
    } catch {
      return '0.00';
    }
  }

  private safeUnlink(filePath: string): void {
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Limpieza best-effort — no vale la pena tumbar el pipeline por esto.
    }
  }

  /**
   * Vuelca un stream a disco respetando la contrapresión (`pipeline`), en vez
   * del viejo `streamToBuffer` que acumulaba chunks y hacía `Buffer.concat`:
   * eso mantenía el archivo entero en RAM y encima duplicaba el pico al
   * concatenar. Acá la memoria usada es un par de chunks, sin importar si el
   * archivo pesa 4 MB o 80 MB.
   *
   * El timeout destruye el stream, lo que hace fallar el `pipeline` y cierra
   * el descriptor del archivo — sin fugas ni temporales a medio escribir.
   */
  private async streamToFile(
    stream: Readable,
    outputPath: string,
    timeoutMs: number,
  ): Promise<void> {
    const timeout = setTimeout(() => {
      stream.destroy(
        new Error(`Timeout: el stream tardó más de ${timeoutMs / 1000} segundos`),
      );
    }, timeoutMs);

    let logged = 0;
    stream.on('data', (chunk: Buffer) => {
      logged += chunk.length;
      if (logged >= 5 * 1024 * 1024) {
        logged = 0;
        console.log(`📥 [STREAM] +5 MB → ${path.basename(outputPath)}`);
      }
    });

    try {
      await pipeline(stream, fs.createWriteStream(outputPath));
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Transcodifica un archivo de disco a mp3. Se le pasa una RUTA y no un
   * stream en memoria: ffmpeg abre el archivo él mismo y puede hacer seek,
   * lo que además evita el `Readable` sintético que empujaba el buffer
   * entero de una sin respetar contrapresión.
   */
  private transcodeToMp3(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`🔄 [FFMPEG] Transcodificando ${path.basename(inputPath)} → mp3`);
      ffmpeg(inputPath)
        .toFormat('mp3')
        .audioBitrate(128)
        .audioChannels(2)
        .audioFrequency(44100)
        .output(outputPath)
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`🔄 [FFMPEG] ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log(`✅ [FFMPEG] Listo: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          console.error(`❌ [FFMPEG] Error:`, error);
          reject(error);
        })
        .run();
    });
  }

  private async uploadFile(filePath: string): Promise<string> {
    // Verificar conectividad básica antes de intentar uploads — pero sólo
    // si no la confirmamos en los últimos CONNECTIVITY_TTL_MS. Antes este
    // chequeo se hacía por cada archivo subido, gastando ~5s por canción
    // aunque la red estuviera claramente bien.
    if (Date.now() - this.lastConnectivityOk > this.CONNECTIVITY_TTL_MS) {
      console.log(`🌐 [CONNECTIVITY] Verificando conectividad de red...`);
      try {
        await this.testConnectivity();
        this.lastConnectivityOk = Date.now();
        console.log(`✅ [CONNECTIVITY] Conectividad verificada`);
      } catch (connectivityError) {
        console.error(`❌ [CONNECTIVITY] Sin conectividad de red:`, connectivityError instanceof Error ? connectivityError.message : connectivityError);
        throw new Error(`❌ Sin conectividad a internet. Verifica tu conexión de red.`);
      }
    }

    // Intentar según prioridad configurada
    const maxRetries = 3;
    const retryDelay = 2000;

    if (this.uploadService === "uguu") {
      console.log(`📤 [UPLOAD] Intentando subir a uguu.se primero (configurado)...`);

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`📤 [UGUU] Intento ${attempt}/${maxRetries} - Subiendo archivo...`);
          return await this.uploadToUguu(filePath);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ [UGUU] Error en intento ${attempt}:`, errorMsg);

          if (attempt === maxRetries) {
            console.log(
              `🔄 [FALLBACK] uguu.se falló tras ${maxRetries} intentos, probando Catbox...`,
            );
            break;
          }
          if (attempt < maxRetries) {
            const delay = errorMsg.includes("ENOTFOUND") ? retryDelay * 2 : retryDelay;
            console.log(`⏱️ Esperando ${delay}ms antes del siguiente intento...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      // Cadena de fallback: Catbox → Litterbox → FileGarden (último recurso si
      // está configurado).
      try {
        const result = await this.uploadToCatboxWithRetry(filePath);
        console.log(`✅ [FALLBACK] Archivo subido exitosamente a Catbox`);
        return result;
      } catch (catboxError) {
        const catboxMsg =
          catboxError instanceof Error ? catboxError.message : String(catboxError);
        console.error(`❌ [FALLBACK] Catbox también falló:`, catboxMsg);
        try {
          const result = await this.uploadToLitterboxFallback(filePath);
          console.log(`✅ [FALLBACK] Archivo subido a Litterbox como último recurso`);
          return result;
        } catch (litterError) {
          const litterMsg =
            litterError instanceof Error ? litterError.message : String(litterError);
          const fg = await this.tryFileGardenLastResort(filePath);
          if (fg) return fg;
          if (litterMsg.includes("ENOTFOUND") || catboxMsg.includes("ENOTFOUND")) {
            throw new Error(`❌ Servicios de subida temporalmente no disponibles. Verifica la conexión.`);
          }
          throw new Error(
            `Todos los servicios fallaron — uguu.se, Catbox y Litterbox. Último: ${litterMsg}`,
          );
        }
      }
    }

    if (this.uploadService === "filegarden") {
      if (!this.hasFileGardenCreds()) {
        console.warn(
          `⚠️ [UPLOAD] UPLOAD_SERVICE=filegarden pero faltan credenciales — usando catbox como primario.`,
        );
      } else {
        console.log(`📤 [UPLOAD] Intentando subir a FileGarden primero (configurado)...`);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            console.log(
              `📤 [FILEGARDEN] Intento ${attempt}/${maxRetries} - Subiendo archivo...`,
            );
            return await this.uploadToFileGarden(filePath);
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            console.error(`❌ [FILEGARDEN] Error en intento ${attempt}:`, errorMsg);

            if (attempt === maxRetries) {
              console.log(
                `🔄 [FALLBACK] FileGarden falló tras ${maxRetries} intentos, probando Catbox...`,
              );
              break;
            }
            if (attempt < maxRetries) {
              const delay = errorMsg.includes("ENOTFOUND")
                ? retryDelay * 2
                : retryDelay;
              console.log(`⏱️ Esperando ${delay}ms antes del siguiente intento...`);
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
        }

        // Cadena de fallback: Catbox → Litterbox (filegarden ya falló como
        // primario, no tiene sentido reintentar como último recurso).
        try {
          const result = await this.uploadToCatboxWithRetry(filePath);
          console.log(`✅ [FALLBACK] Archivo subido exitosamente a Catbox`);
          return result;
        } catch (catboxError) {
          const catboxMsg =
            catboxError instanceof Error ? catboxError.message : String(catboxError);
          console.error(`❌ [FALLBACK] Catbox también falló:`, catboxMsg);
          try {
            const result = await this.uploadToLitterboxFallback(filePath);
            console.log(`✅ [FALLBACK] Archivo subido a Litterbox como último recurso`);
            return result;
          } catch (litterError) {
            const litterMsg =
              litterError instanceof Error ? litterError.message : String(litterError);
            if (litterMsg.includes("ENOTFOUND") || catboxMsg.includes("ENOTFOUND")) {
              throw new Error(`❌ Servicios de subida temporalmente no disponibles. Verifica la conexión.`);
            }
            throw new Error(
              `Todos los servicios fallaron — FileGarden, Catbox y Litterbox. Último: ${litterMsg}`,
            );
          }
        }
      }
    }

    if (this.uploadService === "nullpointer") {
      console.log(`📤 [UPLOAD] Intentando subir a 0x0.st primero (configurado)...`);

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`📤 [0x0.ST] Intento ${attempt}/${maxRetries} - Subiendo archivo...`);
          return await this.uploadToNullpointerWithRetry(filePath);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ [0x0.ST] Error en intento ${attempt}:`, errorMsg);

          if (errorMsg.includes("getaddrinfo ENOTFOUND") || errorMsg.includes("ENOTFOUND")) {
            console.log(`🌐 [DNS] Problema de conectividad detectado con 0x0.st`);
          }

          if (attempt === maxRetries) {
            console.log(`🔄 [FALLBACK] 0x0.st falló tras ${maxRetries} intentos, probando Catbox...`);
            break;
          }

          if (attempt < maxRetries) {
            const delay = errorMsg.includes("ENOTFOUND") ? retryDelay * 2 : retryDelay;
            console.log(`⏱️ Esperando ${delay}ms antes del siguiente intento...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      // Cadena de fallback: Catbox → Litterbox
      try {
        const result = await this.uploadToCatboxWithRetry(filePath);
        console.log(`✅ [FALLBACK] Archivo subido exitosamente a Catbox`);
        return result;
      } catch (catboxError) {
        const catboxMsg = catboxError instanceof Error ? catboxError.message : String(catboxError);
        console.error(`❌ [FALLBACK] Catbox también falló:`, catboxMsg);
        try {
          const result = await this.uploadToLitterboxFallback(filePath);
          console.log(`✅ [FALLBACK] Archivo subido a Litterbox como último recurso`);
          return result;
        } catch (litterError) {
          const litterMsg = litterError instanceof Error ? litterError.message : String(litterError);
          const fg = await this.tryFileGardenLastResort(filePath);
          if (fg) return fg;
          if (litterMsg.includes("ENOTFOUND") || catboxMsg.includes("ENOTFOUND")) {
            throw new Error(`❌ Servicios de subida temporalmente no disponibles. Verifica la conexión.`);
          }
          throw new Error(`Todos los servicios fallaron — 0x0.st, Catbox y Litterbox. Último: ${litterMsg}`);
        }
      }
    }

    if (this.uploadService === "catbox") {
      console.log(`📤 [UPLOAD] Intentando subir a Catbox primero (configurado)...`);
      
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
            console.log(`🔄 [FALLBACK] Catbox falló después de ${maxRetries} intentos, intentando con Litterbox como fallback...`);
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

      // Fallback a Litterbox
      try {
        const result = await this.uploadToLitterboxFallback(filePath);
        console.log(`✅ [FALLBACK] Archivo subido exitosamente a Litterbox como fallback`);
        return result;
      } catch (fallbackError) {
        const fallbackErrorMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);

        const fg = await this.tryFileGardenLastResort(filePath);
        if (fg) return fg;

        // Si ambos servicios fallan por problemas de conectividad, dar un mensaje más útil
        if (fallbackErrorMsg.includes('getaddrinfo ENOTFOUND') || fallbackErrorMsg.includes('ENOTFOUND')) {
          console.error(`🌐 [DNS] Problema de conectividad detectado con ambos servicios`);
          throw new Error(`❌ Servicios de subida temporalmente no disponibles. Verifica tu conexión a internet y intenta nuevamente en unos minutos.`);
        }

        throw new Error(`Error en Catbox y Litterbox fallback: ${fallbackErrorMsg}`);
      }
    } else {
      console.log(`📤 [UPLOAD] Intentando subir a Litterbox primero (configurado)...`);
      
      // Intentar Litterbox con reintentos
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`📤 [LITTERBOX] Intento ${attempt}/${maxRetries} - Subiendo archivo...`);
          return await this.uploadToLitterbox(filePath);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ [LITTERBOX] Error en intento ${attempt}:`, errorMsg);
          
          // Verificar si es un error de conectividad DNS
          if (errorMsg.includes('getaddrinfo ENOTFOUND') || errorMsg.includes('ENOTFOUND')) {
            console.log(`🌐 [DNS] Problema de conectividad detectado con Litterbox`);
          }
          
          if (attempt === maxRetries) {
            console.log(`🔄 [FALLBACK] Litterbox falló después de ${maxRetries} intentos, intentando con Catbox como fallback...`);
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

      // Fallback a Catbox
      try {
        const result = await this.uploadToCatboxWithRetry(filePath);
        console.log(`✅ [FALLBACK] Archivo subido exitosamente a Catbox como fallback`);
        return result;
      } catch (fallbackError) {
        const fallbackErrorMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);

        const fg = await this.tryFileGardenLastResort(filePath);
        if (fg) return fg;

        // Si ambos servicios fallan por problemas de conectividad, dar un mensaje más útil
        if (fallbackErrorMsg.includes('getaddrinfo ENOTFOUND') || fallbackErrorMsg.includes('ENOTFOUND')) {
          console.error(`🌐 [DNS] Problema de conectividad detectado con ambos servicios`);
          throw new Error(`❌ Servicios de subida temporalmente no disponibles. Verifica tu conexión a internet y intenta nuevamente en unos minutos.`);
        }

        throw new Error(`Error en Litterbox y Catbox fallback: ${fallbackErrorMsg}`);
      }
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

  /**
   * Whether FileGarden credentials are present. When true, FileGarden is
   * enabled both as a primary option (UPLOAD_SERVICE=filegarden) and as the
   * final fallback after the catbox/litterbox/nullpointer chain.
   */
  private hasFileGardenCreds(): boolean {
    return (
      !!this.configService.get<string>("music.filegardenUserId") &&
      !!this.configService.get<string>("music.filegardenAuthCookie")
    );
  }

  /**
   * Upload a single file to FileGarden using its private "pipe" endpoint.
   * The API expects raw binary in the body, the file name in the X-Data
   * header (URL-encoded JSON), and auth via the session cookie. Returns the
   * public URL.
   */
  private async uploadToFileGarden(filePath: string): Promise<string> {
    const userId = this.configService.get<string>("music.filegardenUserId");
    const authCookie = this.configService.get<string>(
      "music.filegardenAuthCookie",
    );
    if (!userId || !authCookie) {
      throw new Error(
        "FileGarden no configurado (FILEGARDEN_USER_ID o FILEGARDEN_AUTH_COOKIE vacíos)",
      );
    }

    const filename = path.basename(filePath);
    // The FileGarden API decodes X-Data with decodeURI(), NOT
    // decodeURIComponent() — so reserved chars like ':' and ',' must remain
    // unencoded for the resulting JSON to parse. encodeURI() produces exactly
    // that shape (e.g. `%7B%22parent%22:null,%22name%22:%22x.mp3%22%7D`).
    const xData = encodeURI(JSON.stringify({ parent: null, name: filename }));
    // Stream en vez de readFile: el endpoint acepta el binario crudo en el
    // body, así que no hay razón para tener el archivo entero en RAM (el
    // resto de los uploaders ya usaban createReadStream). Se manda
    // Content-Length explícito porque sin él node-fetch cae a
    // Transfer-Encoding: chunked, que este endpoint rechaza.
    const { size } = await fs.promises.stat(filePath);
    const body = fs.createReadStream(filePath);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch(
        `https://api.filegarden.com/users/${encodeURIComponent(userId)}/pipe`,
        {
          method: "POST",
          headers: {
            Cookie: `auth=${authCookie}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(size),
            "X-Data": xData,
            "User-Agent": "chat-bot/1.0",
          },
          body,
          signal: controller.signal,
        },
      );
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(
          `Error subiendo a FileGarden (${response.status}): ${errText || response.statusText}`,
        );
      }

      // Two response shapes seen in the wild:
      //   1. flat object  → `{ id, name, path, ... }`
      //   2. wrapped list → `{ items: [{ path, ... }] }`
      // Single-file uploads return shape (1); the docs/ShareX template
      // referenced shape (2). Accept both so we don't have to track API drift.
      const json = (await response.json()) as {
        path?: string;
        items?: Array<{ path?: string }>;
      };
      const rawPath = json?.path ?? json?.items?.[0]?.path;
      if (!rawPath) {
        throw new Error(
          `Respuesta inválida de FileGarden: ${JSON.stringify(json)}`,
        );
      }
      // Public CDN host is file.garden (the *.com domain is the dashboard /
      // marketing site; embeds use file.garden which has the right CORS/CDN).
      // The public URL uses a separate share ID — falls back to userId when
      // not configured, since some accounts have the same value for both.
      const publicId =
        this.configService.get<string>("music.filegardenPublicId") || userId;
      return `https://file.garden/${publicId}/${rawPath.replace(/^\/+/, "")}`;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Timeout al subir archivo a FileGarden (60s)");
      }
      throw error;
    }
  }

  /**
   * Last-resort fallback: try FileGarden if creds are configured. Returns
   * null when not configured so the caller can decide whether to throw. Logs
   * but never rethrows so it always reports the original chain failure.
   */
  private async tryFileGardenLastResort(filePath: string): Promise<string | null> {
    if (!this.hasFileGardenCreds()) return null;
    try {
      console.log(`📤 [FILEGARDEN] Último recurso — subiendo archivo...`);
      const url = await this.uploadToFileGarden(filePath);
      console.log(`✅ [FILEGARDEN] Subida exitosa: ${url}`);
      return url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ [FILEGARDEN] Falló como último recurso: ${msg}`);
      return null;
    }
  }

  /**
   * Upload a single file to uguu.se. Multipart with field name `files[]`,
   * JSON response with `files[0].url` carrying the public link. uguu is a
   * temporary host (~3h retention) — fine for chat playback.
   */
  private async uploadToUguu(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("files[]", fs.createReadStream(filePath));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45_000);

    try {
      const response = await fetch("https://uguu.se/upload", {
        method: "POST",
        headers: { "User-Agent": "chat-bot/1.0" },
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(
          `Error subiendo a uguu.se (${response.status}): ${errText || response.statusText}`,
        );
      }

      const json = (await response.json()) as {
        success?: boolean;
        files?: Array<{ url?: string }>;
        description?: string;
      };

      if (json?.success === false) {
        throw new Error(`uguu.se rechazó la subida: ${json.description ?? "desconocido"}`);
      }

      const url = json?.files?.[0]?.url;
      if (!url || !url.startsWith("http")) {
        throw new Error(`Respuesta inválida de uguu.se: ${JSON.stringify(json)}`);
      }
      return url;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Timeout al subir archivo a uguu.se (45s)");
      }
      throw error;
    }
  }

  private async uploadToNullpointer(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));

    const response = await fetch("https://0x0.st", {
      method: "POST",
      headers: {
        // 0x0.st rejects requests with no UA or generic library UAs.
        "User-Agent": "chat-bot/1.0 (catbox-fallback)",
      },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Error subiendo a 0x0.st: ${response.statusText}`);
    }

    const result = (await response.text()).trim();

    if (!result.startsWith("https://")) {
      throw new Error(`Respuesta inválida de 0x0.st: ${result}`);
    }

    return result;
  }

  private async uploadToNullpointerWithRetry(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch("https://0x0.st", {
        method: "POST",
        headers: {
          "User-Agent": "chat-bot/1.0 (catbox-fallback)",
        },
        body: form,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Error subiendo a 0x0.st: ${response.statusText}`);
      }

      const result = (await response.text()).trim();

      if (!result.startsWith("https://")) {
        throw new Error(`Respuesta inválida de 0x0.st: ${result}`);
      }

      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Timeout al subir archivo a 0x0.st (30s)");
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

  /**
   * El servicio que realmente sirvió la URL, no el configurado: uploadFile
   * tiene una cadena de fallback interna que puede terminar en otro host.
   * De esto depende uploadPermanent en el grafo, y por tanto que una fase
   * futura no sirva desde caché un enlace ya expirado.
   */
  private serviceFromUploadUrl(url: string): string {
    if (/litterbox\.catbox\.moe/i.test(url)) return 'litterbox';
    if (/catbox\.moe/i.test(url)) return 'catbox';
    if (/file\.garden/i.test(url)) return 'filegarden';
    if (/uguu\.se/i.test(url)) return 'uguu';
    if (/0x0\.st/i.test(url)) return '0x0';
    return 'unknown';
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

  /**
   * Descarga el audio con yt-dlp directo a `outputPath` como mp3 128K.
   *
   * Reemplaza al viejo `downloadWithYtDlp`, que devolvía un Buffer: leía el
   * mp3 entero con readFileSync y después `prepareAudioFile` se lo pasaba a
   * ffmpeg para "convertirlo a mp3" — o sea, una re-codificación mp3→mp3 que
   * gastaba CPU y degradaba el audio para terminar en el mismo formato. Acá
   * yt-dlp ya escribe el archivo final y no se toca más.
   *
   * `-f bestaudio` baja SÓLO la pista de audio (yt-dlp sí resuelve el
   * PoToken, que es lo que obligaba a ytdl-core a usar el progresivo con
   * video incluido).
   */
  private async downloadAudioWithYtDlp(
    videoUrl: string,
    outputPath: string,
  ): Promise<void> {
    if (!this.ytdlp) {
      throw new Error('yt-dlp no está inicializado');
    }
    if (!(await this.isYtDlpAvailable())) {
      throw new Error('yt-dlp no está disponible en el sistema');
    }

    // yt-dlp le agrega la extensión del formato final al nombre de salida,
    // así que se le pasa la ruta sin `.mp3` y él produce exactamente
    // `outputPath`.
    const base = outputPath.replace(/\.mp3$/i, '');
    const args = [
      videoUrl,
      '-f', 'bestaudio/best',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '128K',
      '--output', `${base}.%(ext)s`,
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--user-agent', this.getRandomUserAgent(),
    ];

    let cookiesFile: string | null = null;
    if (this.youtubeCookies) {
      cookiesFile = `${base}.cookies.txt`;
      try {
        fs.writeFileSync(
          cookiesFile,
          this.convertCookiesToNetscape(this.youtubeCookies),
        );
        args.push('--cookies', cookiesFile);
      } catch (cookieError) {
        console.warn(`⚠️ [YT-DLP] Sin cookies:`, cookieError);
        cookiesFile = null;
      }
    }

    try {
      await this.safeYtDlpExec(args, 120_000);

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        throw new Error('yt-dlp no produjo un mp3 válido');
      }
    } finally {
      if (cookiesFile) this.safeUnlink(cookiesFile);
    }
  }

  /**
   * Build the [audio] BBCode tag with optional metadata (thumb/title/artist)
   * extracted from the ytsr video result. Quotes inside attribute values are
   * escaped as &quot; so the frontend's regex parser stays simple.
   */
  private buildAudioBBCode(audioUrl: string, video: any): string {
    const escapeAttr = (v: string | undefined): string =>
      (v ?? '').toString().replace(/"/g, '&quot;').replace(/[\r\n]+/g, ' ').trim();

    const title = escapeAttr(video?.title);
    const artist = escapeAttr(video?.author?.name);
    const thumb = escapeAttr(video?.bestThumbnail?.url || video?.thumbnails?.[0]?.url);

    const attrs: string[] = [];
    if (thumb) attrs.push(`thumb="${thumb}"`);
    if (title) attrs.push(`title="${title}"`);
    if (artist) attrs.push(`artist="${artist}"`);

    const opening = attrs.length ? `[audio ${attrs.join(' ')}]` : '[audio]';
    return `${opening}${audioUrl}[/audio]`;
  }

  /**
   * Convierte una duración en formato de YouTube (ej: "3:45", "1:23:45") a minutos
   */
  private parseDurationToMinutes(duration: string): number {
    try {
      // Eliminar espacios y convertir a minúsculas
      const cleanDuration = duration.trim();
      
      // Separar por ':'
      const parts = cleanDuration.split(':').map(part => parseInt(part, 10));
      
      if (parts.length === 2) {
        // Formato MM:SS
        const [minutes, seconds] = parts;
        return minutes + (seconds / 60);
      } else if (parts.length === 3) {
        // Formato HH:MM:SS
        const [hours, minutes, seconds] = parts;
        return (hours * 60) + minutes + (seconds / 60);
      } else {
        console.warn(`⚠️ [DURATION] Formato de duración no reconocido: ${duration}`);
        return 0; // Permitir si no podemos parsear
      }
    } catch (error) {
      console.error(`❌ [DURATION] Error parseando duración "${duration}":`, error);
      return 0; // Permitir si hay error en parsing
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
