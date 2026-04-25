import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { io, Socket } from 'socket.io-client';
import { randomUUID } from 'crypto';

export interface ChatMessage {
  _id: string;
  content: string;
  authorUsername: string;
  authorColor?: string;
  authorAvatar?: string;
  authorRole?: string;
  type: 'text' | 'sticker';
  createdAt: string;
}

@Injectable()
export class ChatSocketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatSocketService.name);
  private socket: Socket | null = null;
  private jwt: string | null = null;
  private botUsername: string | null = null;
  private messageHandler: ((msg: ChatMessage) => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pendingAcks = new Map<string, { resolve: (id: string | null) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    await this.connect();
  }

  onModuleDestroy() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.disconnect();
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
      }
    });

    this.socket.on('joinError', (data: { message: string }) => {
      this.logger.error(`joinError: ${data.message}`);
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

  private scheduleReconnect(delayMs = 5000) {
    if (this.reconnectTimer) return;
    this.logger.log(`Reconnecting in ${delayMs / 1000}s…`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.socket?.disconnect();
      this.socket = null;
      await this.connect();
    }, delayMs);
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
