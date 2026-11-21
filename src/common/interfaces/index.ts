/** Metadatos de una pista ya resuelta y subida. */
export interface TrackMeta {
  title: string;
  artist: string | null;
  thumb: string | null;
  youtubeUrl: string | null;
  uploadUrl: string;
  uploadService: string;
}

/**
 * Lo que resuelve processMusic/processVideo. Antes era solo el string; se
 * ensanchó para que el grafo pueda registrar la pista sin re-parsear el
 * BBCode del mensaje.
 */
export interface MusicResult {
  text: string;
  track: TrackMeta | null;
  /**
   * El BBCode del archivo (`[audio …]…[/audio]` / `[video]…[/video]`) sin
   * texto alrededor. Presente sólo cuando el pedido salió bien: con esto el
   * bot arma su propio mensaje de entrega (una frase corta del modelo + el
   * archivo) en vez del `text` fijo, que queda como fallback.
   */
  media?: string;
}

/**
 * Etapa en la que está un pedido dentro del pipeline. Se usa sólo para
 * reportar estado (`getQueueStatus`, feedback al usuario); el avance real lo
 * gobiernan los semáforos de MusicService.
 */
export type MusicStage = 'queued' | 'searching' | 'downloading' | 'uploading';

export interface MusicRequest {
  query: string;
  username: string;
  kind?: 'audio' | 'video';
  /** Etapa actual, para el reporte de posición en la cola. */
  stage?: MusicStage;
  /**
   * Callback opcional para avisarle al usuario cómo va su pedido (posición en
   * la cola, "descargando…"). Es best-effort: si lanza, el pipeline sigue.
   */
  onProgress?: (update: MusicProgress) => void;
  resolve: (value: MusicResult) => void;
  reject: (error: Error) => void;
}

/** Avance reportado a quien encoló el pedido. */
export interface MusicProgress {
  stage: MusicStage;
  /** 1 = es el próximo en entrar a la descarga. 0 = ya está en proceso. */
  position: number;
  /** Texto ya armado y listo para mostrarle al usuario. */
  text: string;
}

export interface YouTubeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expirationDate?: number;
  hostOnly?: boolean;
  session?: boolean;
  storeId?: string;
  id?: number;
}

export interface QueueStatus {
  isProcessing: boolean;
  queueLength: number;
  /** Desglose por etapa — el pipeline corre varias a la vez. */
  searching: number;
  downloading: number;
  uploading: number;
}
