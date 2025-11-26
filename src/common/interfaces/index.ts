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

export interface MusicRequest {
  query: string;
  username: string;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
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
}