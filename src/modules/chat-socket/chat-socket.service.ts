import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { io, Socket } from 'socket.io-client';
import { randomUUID } from 'crypto';
import { normalizeMessageText, ReplyContext } from './reply-context';
import { CatalogCategory, CatalogSticker, StickerCatalogService } from './sticker-catalog.service';
import { BbcodeSettingsService } from './bbcode-settings.service';

/**
 * Cuántos mensajes recientes se recuerdan para resolver el texto COMPLETO del
 * mensaje al que alguien responde. El snapshot `replyTo.contentExcerpt` del
 * backend viene cortado a 140 caracteres; si el padre pasó por el socket
 * mientras el bot estaba conectado, se usa el texto entero desde acá.
 */
const RECENT_MESSAGES_LIMIT = 500;

/**
 * El gateway borra el "escribiendo…" a los 3 s del último `typing`. Se reenvía
 * un poco antes para que no parpadee mientras el modelo piensa.
 */
const TYPING_REFRESH_MS = 2500;

/** Tope de seguridad: un "escribiendo…" nunca dura más que esto aunque nadie lo corte. */
const TYPING_MAX_MS = 60_000;

/** Primer reintento de reconexión; se duplica en cada fallo seguido. */
export const RECONNECT_BASE_MS = 5_000;
/** Techo del backoff: con el backend caído, un intento cada 5 min como mucho. */
export const RECONNECT_MAX_MS = 5 * 60_000;
/** Cuánto se espera la autenticación por HTTP antes de darla por fallida. */
const AUTH_TIMEOUT_MS = 15_000;

/**
 * Espera antes del intento número `attempt` (0 = primero): exponencial con
 * techo, más hasta un 20 % al azar para que varias instancias no reintenten
 * todas en el mismo segundo. `rand` es inyectable para los tests.
 */
export function reconnectDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_MS);
  return Math.round(base * (1 + 0.2 * rand()));
}

export interface ChatMessage {
  _id: string;
  content: string;
  authorUsername: string;
  authorColor?: string;
  authorAvatar?: string;
  authorRole?: string;
  type: 'text' | 'sticker';
  createdAt: string;
  // Snapshot del mensaje al que se responde (Discord-style replies). Presente
  // cuando repliesEnabled=true; con replies desactivadas el backend reescribe
  // el contenido con una mención en vez de mandar este campo.
  replyTo?: {
    messageId: string;
    authorUsername: string;
    authorColor: string;
    contentExcerpt: string;
  } | null;
}

@Injectable()
export class ChatSocketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatSocketService.name);
  private socket: Socket | null = null;
  private jwt: string | null = null;
  private botUsername: string | null = null;
  private messageHandler: ((msg: ChatMessage) => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Fallos seguidos desde la última vez que el bot entró al chat. */
  private reconnectAttempts = 0;
  /** Apagando: ningún evento del socket puede programar otra reconexión. */
  private shuttingDown = false;
  private pendingAcks = new Map<string, { resolve: (id: string | null) => void; timer: NodeJS.Timeout }>();
  /** Mensajes recientes por `_id` (orden de inserción = antigüedad), incluidos los del propio bot. */
  private recentMessages = new Map<string, { authorUsername: string; content: string; type?: string }>();
  /** `settings.reactionsEnabled`: llega en el `init` y en vivo con `reactionsState`. */
  private reactionsOn = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly stickerCatalog: StickerCatalogService,
    // Opcional para no obligar a cada test que arma el servicio a proveerlo.
    @Optional() private readonly bbcodeSettings?: BbcodeSettingsService,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  onModuleDestroy() {
    // Antes: `disconnect()` disparaba el evento 'disconnect', cuyo handler
    // programaba una reconexión — al apagar, el bot volvía a conectarse y el
    // timer mantenía vivo el proceso.
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.dropSocket();
  }

  /** Suelta el socket actual sin que sus eventos disparen nada más. */
  private dropSocket(): void {
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
  }

  /** Register a handler to be called for every incoming message */
  onMessage(handler: (msg: ChatMessage) => void) {
    this.messageHandler = handler;
  }

  private async connect(): Promise<void> {
    const apiUrl = this.configService.get<string>('chat.apiUrl')!;
    const apiKey = this.configService.get<string>('chat.apiKey')!;

    if (!apiKey) {
      this.logger.warn('CHAT_API_KEY not set — skipping chat socket connection');
      return;
    }

    try {
      // 1. Exchange API key for JWT
      const res = await fetch(`${apiUrl}/api/auth/bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
        // Sin esto, un backend colgado dejaba el connect esperando para siempre
        // y nunca se programaba el reintento.
        signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Auth failed (${res.status}): ${body}`);
      }

      const data = await res.json() as { access_token: string; user: { username: string } };
      this.jwt = data.access_token;
      this.botUsername = data.user.username;
      this.logger.log(`✅ Authenticated as bot: ${this.botUsername}`);
    } catch (err) {
      this.logger.error(`Auth error: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }

    // 2. Connect socket.io
    const apiUrl2 = this.configService.get<string>('chat.apiUrl')!;
    const socketUrl = apiUrl2.replace('/api', '').replace(/\/$/, '');

    this.socket = io(socketUrl, {
      auth: { token: this.jwt },
      transports: ['websocket'],
      reconnection: false, // We handle reconnect manually
    });

    this.socket.on('connect', () => {
      this.logger.log('🔌 Connected to chat socket');
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      // Join the chat room with JWT
      this.socket!.emit('joinChat', { token: this.jwt, username: this.botUsername });
    });

    this.socket.on('joinedChat', (data: { success: boolean }) => {
      if (data.success) {
        this.logger.log(`🤖 Joined chat as ${this.botUsername}`);
        // Recién acá cuenta como conexión buena: conectar el socket y que
        // después rebote el join no debe resetear el backoff.
        this.reconnectAttempts = 0;
      }
    });

    // Catálogo de stickers: llega con el `init` de cada conexión y se refresca
    // con `stickersUpdated` (alta/edición/categorías desde el panel admin).
    // `stickers` son los activos del set activo; `allStickers` no se usa (trae
    // también los privados y los borrados, que el bot no debe ofrecer).
    type StickerPayload = { stickers?: CatalogSticker[]; stickerCategories?: CatalogCategory[] };
    this.socket.on('init', (data: StickerPayload & { theme?: { disabledBbcodes?: unknown; reactionsEnabled?: unknown } }) => {
      this.stickerCatalog.update(data?.stickers, data?.stickerCategories);
      this.reactionsOn = data?.theme?.reactionsEnabled === true;
      // BBCodes apagados por el admin: vienen en el theme del `init` y en vivo
      // con `bbcodesState` (ver docs/bbcode-contexto.md).
      this.bbcodeSettings?.update(data?.theme?.disabledBbcodes);
    });
    this.socket.on('bbcodesState', (data: { disabled?: unknown }) => {
      this.bbcodeSettings?.update(data?.disabled);
    });
    this.socket.on('reactionsState', (data: { enabled?: unknown }) => {
      this.reactionsOn = data?.enabled === true;
    });
    this.socket.on('reactionError', (data: { message?: string }) => {
      this.logger.warn(`reactionError: ${data?.message ?? '(sin mensaje)'}`);
    });
    this.socket.on('stickersUpdated', (data: StickerPayload) => {
      this.stickerCatalog.update(data?.stickers, data?.stickerCategories);
    });

    // Antes sólo se logueaba: el socket quedaba conectado pero fuera de la
    // sala 'joined' (sin presencia) y, si el rechazo era por rol o API key, el
    // bot quedaba sordo sin que nadie lo notara. Ahora se suelta el socket y
    // se reintenta con backoff (y el error queda en el log en cada intento).
    this.socket.on('joinError', (data: { message?: string }) => {
      this.logger.error(`joinError: ${data?.message ?? '(sin mensaje)'} — reintentando con backoff`);
      this.dropSocket();
      this.scheduleReconnect();
    });

    this.socket.on('newMessage', (msg: ChatMessage & { clientId?: string }) => {
      // Resolve any pending ack waiting on this clientId, then early-return for own messages
      if (msg.clientId) {
        const pending = this.pendingAcks.get(msg.clientId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingAcks.delete(msg.clientId);
          pending.resolve(msg._id);
        }
      }
      // Se registra ANTES del early-return de mensajes propios: responderle a
      // un mensaje del bot es el caso más común de reply dirigido al bot.
      this.rememberMessage(msg);
      if (msg.authorUsername?.toLowerCase() === this.botUsername?.toLowerCase()) return;
      this.messageHandler?.(msg);
    });

    this.socket.on('disconnect', (reason: string) => {
      this.logger.warn(`Disconnected: ${reason}`);
      this.scheduleReconnect();
    });

    this.socket.on('connect_error', (err: Error) => {
      this.logger.error(`connect_error: ${err.message}`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.shuttingDown) return;
    const delayMs = reconnectDelay(this.reconnectAttempts);
    this.reconnectAttempts++;
    this.logger.log(`Reconnecting in ${Math.round(delayMs / 1000)}s (intento ${this.reconnectAttempts})…`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.dropSocket();
      await this.connect();
    }, delayMs);
  }

  private rememberMessage(msg: ChatMessage): void {
    if (!msg?._id || !msg.authorUsername) return;
    this.recentMessages.set(msg._id, {
      authorUsername: msg.authorUsername,
      content: msg.content ?? '',
      type: msg.type,
    });
    while (this.recentMessages.size > RECENT_MESSAGES_LIMIT) {
      const oldest = this.recentMessages.keys().next().value as string;
      this.recentMessages.delete(oldest);
    }
  }

  /**
   * Contexto del mensaje al que responde `msg`, o `null` si no es un reply.
   * Prefiere el texto completo del buffer y cae al `contentExcerpt` del
   * snapshot (cortado a 140) si el padre es más viejo que el buffer o llegó
   * antes de que el bot se conectara.
   *
   * Con `repliesEnabled=false` el backend no manda `replyTo` (reescribe el
   * contenido con una mención), así que no hay forma de saber a qué mensaje
   * se respondía: devuelve `null`.
   */
  getReplyContext(msg: ChatMessage): ReplyContext | null {
    const replyTo = msg.replyTo;
    if (!replyTo?.authorUsername) return null;
    const known = replyTo.messageId ? this.recentMessages.get(replyTo.messageId) : undefined;
    // Un sticker padre se describe por su nombre ("[sticker: Gato llorando]")
    // en vez del "[sticker]" genérico de normalizeMessageText.
    const content = known
      ? normalizeMessageText(this.stickerCatalog.describeContent(known.content, known.type))
      : normalizeMessageText(replyTo.contentExcerpt);
    if (!content) return null;
    return { author: known?.authorUsername ?? replyTo.authorUsername, content };
  }

  /** Send a text message to the chat */
  sendMessage(content: string): void {
    if (!this.socket?.connected) {
      this.logger.warn('Cannot send message — not connected');
      return;
    }
    this.socket.emit('sendMessage', { content, type: 'text' });
  }

  /**
   * Send a message and wait for the server to echo it back so we know its _id.
   * Returns null if the gateway never echoes (e.g. dropped by chatPaused / anti-spam)
   * within the timeout. The gateway echoes our clientId on the broadcast newMessage.
   */
  sendMessageAndAwaitId(content: string, timeoutMs = 5000): Promise<string | null> {
    if (!this.socket?.connected) {
      this.logger.warn('Cannot send message — not connected');
      return Promise.resolve(null);
    }
    const clientId = randomUUID();

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(clientId);
        resolve(null);
      }, timeoutMs);
      this.pendingAcks.set(clientId, { resolve, timer });
      this.socket!.emit('sendMessage', { content, type: 'text', clientId });
    });
  }

  /** Envía un sticker del catálogo (`code` sin los dos puntos). */
  sendSticker(code: string): void {
    if (!this.socket?.connected) {
      this.logger.warn('Cannot send sticker — not connected');
      return;
    }
    this.socket.emit('sendMessage', { content: `:${code}:`, type: 'sticker' });
  }

  /**
   * Muestra "<bot> está escribiendo…" hasta que se llame a la función que
   * devuelve (idempotente). Hay que llamarla siempre, también si falla lo que
   * se estaba esperando: va en un `finally`.
   */
  startTyping(): () => void {
    const emit = () => {
      if (this.socket?.connected) this.socket.emit('typing');
    };
    emit();
    const interval = setInterval(emit, TYPING_REFRESH_MS);
    const cap = setTimeout(() => stop(), TYPING_MAX_MS);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      clearTimeout(cap);
    };
    return stop;
  }

  /** Si el admin tiene las reacciones encendidas. */
  get reactionsEnabled(): boolean {
    return this.reactionsOn;
  }

  /**
   * Reacciona a un mensaje. Ojo: el gateway hace *toggle*, así que repetir el
   * mismo emoji sobre el mismo mensaje la saca.
   */
  toggleReaction(messageId: string, emoji: string): void {
    if (!this.socket?.connected || !messageId || !emoji) return;
    this.socket.emit('toggleReaction', { messageId, emoji });
  }

  /** Delete a message by id (the bot has 'bot' role and may delete its own messages) */
  deleteMessage(messageId: string): void {
    if (!this.socket?.connected || !messageId) return;
    this.socket.emit('deleteMessage', { messageId });
  }

  /** Fetch connected users from the REST API */
  async getOnlineUsers(): Promise<{ username: string; role: string; isActive: boolean }[]> {
    const apiUrl = this.configService.get<string>('chat.apiUrl')!;
    if (!this.jwt) return [];
    try {
      const res = await fetch(`${apiUrl}/api/users/online`, {
        headers: { Authorization: `Bearer ${this.jwt}` },
      });
      if (!res.ok) return [];
      return res.json();
    } catch {
      return [];
    }
  }

  get isConnected(): boolean {
    return !!this.socket?.connected;
  }

  get username(): string | null {
    return this.botUsername;
  }
}
