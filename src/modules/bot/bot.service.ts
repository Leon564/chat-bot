import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatService } from '../chat/chat.service';
import { MusicService } from '../music/music.service';
import { UtilsService } from '../../common/utils/utils.service';
import { LoggingService } from '../../common/utils/logging.service';
import { MemoryService } from '../../common/utils/memory.service';
import { ChatSocketService, ChatMessage } from '../chat-socket/chat-socket.service';

@Injectable()
export class BotService implements OnModuleInit {
  constructor(
    private readonly configService: ConfigService,
    private readonly chatService: ChatService,
    private readonly musicService: MusicService,
    private readonly utilsService: UtilsService,
    private readonly loggingService: LoggingService,
    private readonly memoryService: MemoryService,
    private readonly chatSocketService: ChatSocketService,
  ) {}

  async onModuleInit() {
    console.log('🤖 Inicializando Bot Service...');

    const useMemory = this.configService.get<boolean>('bot.useMemory');
    if (useMemory) {
      await this.memoryService.migrateMemoriesToUserFormat();
      await this.memoryService.cleanExistingMemories();
    }

    this.chatSocketService.onMessage((msg) => this.handleNewChatMessage(msg));
  }

  // ─── Message dispatcher ────────────────────────────────────────────────────

  private async handleNewChatMessage(msg: ChatMessage): Promise<void> {
    const { content, authorUsername } = msg;
    if (!content || !authorUsername) return;

    const botUsername = this.chatSocketService.username ?? 'bot';

    await this.loggingService.saveLog(authorUsername, content);

    const containsExactBotName = (text: string): boolean =>
      new RegExp(`\\b${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);

    const containsBotWord = (text: string): boolean => /\bbot\b/i.test(text);

    const isMusicRequest = MusicService.isMusicRequest(content);
    const isOnlineReq = this.isOnlineUsersRequest(content);
    const videoEnabled = !!this.configService.get<boolean>('video.enabled');
    const isVideoReq = videoEnabled && MusicService.isVideoRequest(content);

    if (
      !containsBotWord(content) &&
      !containsExactBotName(content) &&
      !isMusicRequest &&
      !isOnlineReq &&
      !isVideoReq
    ) return;

    console.log(`📨 Mensaje de ${authorUsername}: "${content}"`);

    if (isVideoReq) {
      await this.handleVideoRequest(content, authorUsername);
      return;
    }

    if (isMusicRequest) {
      await this.handleMusicRequest(content, authorUsername);
      return;
    }

    if (isOnlineReq) {
      await this.handleOnlineUsersRequest(authorUsername);
      return;
    }

    // Debug commands (owner only)
    if (authorUsername === 'Leon564' && content.toLowerCase().includes('debug')) {
      const qs = this.musicService.getQueueStatus();
      this.sendBotMessage(`@${authorUsername} Debug: Procesando=${qs.isProcessing}, Cola=${qs.queueLength} 🎵`);
      return;
    }

    const response = await this.chatService.chat(content, botUsername, authorUsername);
    if (!response) return;

    await this.handleChatResponse(response, authorUsername);
  }

  // ─── Music ─────────────────────────────────────────────────────────────────

  private async handleMusicRequest(message: string, authorUsername: string): Promise<void> {
    const query = MusicService.extractMusicQuery(message);
    if (!query || query.trim().length < 2) {
      this.sendBotMessage(`@${authorUsername} 🤔 No entendí qué canción quieres. Probá con: "!music nombre de la canción"`);
      return;
    }

    const searchingId = await this.sendBotMessageAndAwaitId(
      `@${authorUsername} 🎵 Buscando "${query}"… un momento.`,
    );

    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;

    this.musicService
      .processMusic(query, authorUsername)
      .then(async (result) => {
        await this.utilsService.sleep(responseDelay);
        if (searchingId) this.chatSocketService.deleteMessage(searchingId);
        this.sendBotMessage(result);
      })
      .catch(async (error: Error) => {
        await this.utilsService.sleep(responseDelay);
        if (searchingId) this.chatSocketService.deleteMessage(searchingId);
        this.sendBotMessage(`@${authorUsername} ${this.friendlyMusicError(error, query)}`);
      });
  }

  // ─── Video ─────────────────────────────────────────────────────────────────

  private async handleVideoRequest(message: string, authorUsername: string): Promise<void> {
    const query = MusicService.extractVideoQuery(message);
    if (!query || query.trim().length < 2) {
      this.sendBotMessage(`@${authorUsername} 🤔 No entendí qué video quieres. Probá con: "!video nombre del video"`);
      return;
    }

    const searchingId = await this.sendBotMessageAndAwaitId(
      `@${authorUsername} 🎬 Buscando video "${query}"… un momento.`,
    );

    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;

    this.musicService
      .processVideo(query, authorUsername)
      .then(async (result) => {
        await this.utilsService.sleep(responseDelay);
        if (searchingId) this.chatSocketService.deleteMessage(searchingId);
        this.sendBotMessage(result);
      })
      .catch(async (error: Error) => {
        await this.utilsService.sleep(responseDelay);
        if (searchingId) this.chatSocketService.deleteMessage(searchingId);
        this.sendBotMessage(`@${authorUsername} ${this.friendlyVideoError(error, query)}`);
      });
  }

  /** Same friendly mapping as music but with a video-flavoured default. */
  private friendlyVideoError(error: Error, query: string): string {
    const lower = (error?.message ?? '').toString().toLowerCase();
    if (lower.includes('no se encontraron resultados')) {
      return `🔎 No encontré ningún video para "${query}". Probá con otro término.`;
    }
    if (lower.includes('demasiado largo')) {
      return `⏱️ Ese video es demasiado largo para mí. Probá con uno más corto.`;
    }
    if (lower.includes('sin conectividad') || lower.includes('econn') || lower.includes('etimedout')) {
      return `📡 Estoy teniendo problemas de conexión. Intentalo de nuevo en un minuto.`;
    }
    if (lower.includes('temporalmente no disponibles') || lower.includes('servicios de subida')) {
      return `☁️ Los servicios de subida están caídos ahora mismo. Probá más tarde.`;
    }
    if (lower.includes('ytdl') || lower.includes('yt-dlp') || lower.includes('descargar el video')) {
      return `🎬 No pude descargar ese video (YouTube anda raro). Probá con otro o más tarde.`;
    }
    return `😕 No pude procesar el video "${query}" esta vez. Intentalo de nuevo en un rato.`;
  }

  /**
   * Map technical errors from MusicService to user-friendly messages.
   * Anything we don't recognize falls back to a generic "no se pudo" message
   * so the user never sees yt-dlp / ytdl-core stack details.
   */
  private friendlyMusicError(error: Error, query: string): string {
    const raw = (error?.message ?? '').toString();
    const lower = raw.toLowerCase();

    if (lower.includes('no se encontraron resultados')) {
      return `🔎 No encontré nada para "${query}". Probá con otro nombre o agregá el artista.`;
    }
    if (lower.includes('demasiado largo')) {
      return `⏱️ Esa canción es demasiado larga para mí. Probá con una versión más corta.`;
    }
    if (lower.includes('sin conectividad') || lower.includes('econn') || lower.includes('etimedout')) {
      return `📡 Estoy teniendo problemas de conexión. Intentalo de nuevo en un minuto.`;
    }
    if (lower.includes('temporalmente no disponibles') || lower.includes('servicios de subida')) {
      return `☁️ Los servicios de subida están caídos ahora mismo. Probá más tarde.`;
    }
    if (lower.includes('ytdl') || lower.includes('yt-dlp') || lower.includes('descargar el audio')) {
      return `🎧 No pude descargar esa canción (YouTube anda raro). Probá con otra o más tarde.`;
    }
    return `😕 No pude procesar "${query}" esta vez. Intentalo de nuevo en un rato.`;
  }

  // ─── Online users ──────────────────────────────────────────────────────────

  private async handleOnlineUsersRequest(authorUsername: string): Promise<void> {
    const users = await this.chatSocketService.getOnlineUsers();
    if (users.length === 0) {
      this.chatSocketService.sendMessage(
        `@${authorUsername} 👥 No hay nadie conectado en este momento.`,
      );
      return;
    }

    const ROLE_ORDER = ['admin', 'mod', 'bot', 'user', 'guest'] as const;
    const ROLE_LABELS: Record<string, string> = {
      admin: 'Admins',
      mod: 'Moderadores',
      bot: 'Bots',
      user: 'Usuarios',
      guest: 'Invitados',
    };

    const grouped: Record<string, typeof users> = {};
    for (const u of users) {
      const key = u.role === 'superAdmin' ? 'admin' : u.role;
      (grouped[key] ??= []).push(u);
    }

    const total = users.length;
    let summary = `👥 **${total} persona${total !== 1 ? 's' : ''} en línea:**\n\n`;

    for (const role of ROLE_ORDER) {
      const group = grouped[role];
      if (!group?.length) continue;
      const label = ROLE_LABELS[role] ?? role;
      summary += `**${label} (${group.length}):**\n`;
      for (const u of group) {
        const icon = u.isActive ? '🟢' : '🟡';
        summary += `${icon} ${u.username}\n`;
      }
      summary += '\n';
    }

    this.sendBotMessage(`@${authorUsername} ${summary.trimEnd()}`);
  }

  // ─── Chat / GPT response ───────────────────────────────────────────────────

  private async handleChatResponse(response: string, authorUsername: string): Promise<void> {
    const maxLength = this.configService.get<number>('bot.maxLengthResponse') || 200;
    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;

    if (response.includes('{{resumen}}')) {
      await this.handleSummaryRequest(response, authorUsername);
      return;
    }

    if (response.includes('{{usuarios_online}}')) {
      const confirmText = response.replace('{{usuarios_online}}', '').trim();
      if (confirmText) {
        this.sendBotMessage(`@${authorUsername} ${confirmText}`);
        await this.utilsService.sleep(responseDelay);
      }
      await this.handleOnlineUsersRequest(authorUsername);
      return;
    }

    const parts = this.utilsService.splitMessageIntoParts(response, maxLength);
    for (let i = 0; i < parts.length; i++) {
      const text = i === 0 ? `<@${authorUsername}> ${parts[i]}` : parts[i];
      this.sendBotMessage(text);
      if (i < parts.length - 1) await this.utilsService.sleep(responseDelay);
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  private async handleSummaryRequest(response: string, authorUsername: string): Promise<void> {
    const lastResumenEvent = await this.loggingService.getLastEventType('Resumen');
    if (lastResumenEvent.minutesLeft < 10) {
      this.sendBotMessage(`@${authorUsername} Puedes leer el resumen anterior y esperar 10 minutos para generar uno nuevo. 🙂`);
      return;
    }

    const confirmationMessage = response.replace('{{resumen}}', '').trim();
    if (confirmationMessage) {
      this.sendBotMessage(`@${authorUsername} ${confirmationMessage}`);
    }

    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
    const maxLength = this.configService.get<number>('bot.maxLengthResponse') || 200;
    await this.utilsService.sleep(responseDelay);

    try {
      console.log('📋 Generando resumen del chat...');
      const resumen = await this.chatService.generateSummary();
      const resumenParts = this.utilsService.splitMessageIntoParts(resumen, maxLength);
      console.log(`📋 Enviando resumen en ${resumenParts.length} parte(s)`);

      for (let i = 0; i < resumenParts.length; i++) {
        const part = resumenParts[i].trim();
        if (!part) continue;
        const partIndicator = resumenParts.length > 1 ? ` (${i + 1}/${resumenParts.length})` : '';
        const prefix = i === 0
          ? `📋✨ RESUMEN DEL CHAT${partIndicator}\n\n`
          : `📋 RESUMEN${partIndicator}\n\n`;
        const suffix =
          i === resumenParts.length - 1 && resumenParts.length > 1
            ? '\n\n¡Eso es todo por ahora! 🎬'
            : '';
        this.sendBotMessage(`${prefix}${part}${suffix}`);
        if (i < resumenParts.length - 1) await this.utilsService.sleep(responseDelay);
      }

      await this.loggingService.saveEventsLog('Resumen', authorUsername);
      const clearedCount = await this.loggingService.clearMessagesLog();
      console.log(`✅ Resumen completado y log limpiado (${clearedCount} mensajes eliminados)`);
    } catch (error) {
      console.error('❌ Error generating summary:', error);
      this.sendBotMessage('❌ Error al generar el resumen. Inténtalo más tarde.');
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Send a bot message prefixed with the configured color code if provided */
  private sendBotMessage(text: string): void {
    const color = this.configService.get<string>('bot.textColor') || process.env.TEXT_COLOR || '';
    const prefix = color ? `^#${color} ` : '';
    this.chatSocketService.sendMessage(`${prefix}${text}`);
  }

  /** Same as sendBotMessage but resolves with the server-assigned message _id */
  private sendBotMessageAndAwaitId(text: string): Promise<string | null> {
    const color = this.configService.get<string>('bot.textColor') || process.env.TEXT_COLOR || '';
    const prefix = color ? `^#${color} ` : '';
    return this.chatSocketService.sendMessageAndAwaitId(`${prefix}${text}`);
  }


  private isOnlineUsersRequest(message: string): boolean {
    if (!message || typeof message !== 'string') return false;
    const lower = message.toLowerCase();
    const keywords = [
      'quién está en línea', 'quien esta en linea',
      'quienes están en línea', 'quienes estan en linea',
      'usuarios en línea', 'usuarios en linea',
      'lista de usuarios', 'who is online', 'online users', 'users online',
      'gente en línea', 'gente en linea',
      'cuántos están en línea', 'cuantos estan en linea',
      'cuántos online', 'cuantos online',
      'lista online', 'ver usuarios', 'usuarios conectados',
      'conectados', 'en línea', 'en linea', 'online',
    ];
    return keywords.some((kw) => lower.includes(kw));
  }
}

