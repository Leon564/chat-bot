export interface LoginParams {
  username: string;
  password: string;
  boxId: string;
  boxTag: string;
  iframeUrl: string;
}

export interface LoginResponse {
  state: string;
  auth_methods: string[];
  udata: {
    nme: string;
    uid?: string;
    lvl?: string;
    url: string;
    pic?: string;
    key?: string;
  };
  message: string;
  error: string;
}

export interface BoxDetails {
  boxId: string | undefined;
  boxTag: string | undefined;
  socketUrl: string | undefined;
  iframeUrl: string | undefined;
}

export interface SendMessageOptions {
  message: string;
  username: string;
  key: string;
  pic: string;
  boxId: string;
  boxTag: string;
  iframeUrl: string;
}

export interface MessageData {
  id: string;
  date: string;
  name: string;
  lvl: string;
  message: string;
}

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

export interface BotSession {
  uname: string;
  ukey: string;
  pic: string;
  boxId: string;
  boxTag: string;
  iframeUrl: string;
  lastLoginTime: number;
}

export interface QueueStatus {
  isProcessing: boolean;
  queueLength: number;
  /** Desglose por etapa — el pipeline corre varias a la vez. */
  searching: number;
  downloading: number;
  uploading: number;
}

export interface OnlineUser {
  id: string;
  name: string;
  level: number;
  levelName: string; // 'Adm', 'Mod', 'Reg', etc.
  presence: 'active' | 'idle';
  presenceTime: number;
  picture: string;
  profileUrl?: string;
}

export interface OnlineUsersResponse {
  users: OnlineUser[];
  guestCount: number;
  totalCount: number;
}