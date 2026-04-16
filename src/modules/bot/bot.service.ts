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

    if (!containsBotWord(content) && !containsExactBotName(content) && !isMusicRequest && !isOnlineReq) return;

    console.log(`📨 Mensaje de ${authorUsername}: "${content}"`);

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
      this.chatSocketService.sendMessage(
        `@${authorUsername} Debug: Procesando=${qs.isProcessing}, Cola=${qs.queueLength} 🎵`,
      );
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
      this.chatSocketService.sendMessage(
        `@${authorUsername} ❌ No pude entender qué música quieres. Intenta: "!music nombre de la canción"`,
      );
      return;
    }

    this.chatSocketService.sendMessage(`@${authorUsername} 🎵 Buscando "${query}"… un momento.`);

    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;

    this.musicService
      .processMusic(query, authorUsername)
      .then(async (result) => {
        await this.utilsService.sleep(responseDelay);
        this.chatSocketService.sendMessage(result);
      })
      .catch(async (error: Error) => {
        await this.utilsService.sleep(responseDelay);
        this.chatSocketService.sendMessage(`@${authorUsername} ❌ ${error.message}`);
      });
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
    const names = users.map((u) => u.username).join(', ');
    this.chatSocketService.sendMessage(
      `@${authorUsername} 👥 Usuarios en línea (${users.length}): ${names}`,
    );
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
        this.chatSocketService.sendMessage(`@${authorUsername} ${confirmText}`);
        await this.utilsService.sleep(responseDelay);
      }
      await this.handleOnlineUsersRequest(authorUsername);
      return;
    }

    const parts = this.utilsService.splitMessageIntoParts(response, maxLength);
    for (let i = 0; i < parts.length; i++) {
      const text = i === 0 ? `@${authorUsername} ${parts[i]}` : parts[i];
      this.chatSocketService.sendMessage(text);
      if (i < parts.length - 1) await this.utilsService.sleep(responseDelay);
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  private async handleSummaryRequest(response: string, authorUsername: string): Promise<void> {
    const lastResumenEvent = await this.loggingService.getLastEventType('Resumen');
    if (lastResumenEvent.minutesLeft < 10) {
      this.chatSocketService.sendMessage(
        `@${authorUsername} Puedes leer el resumen anterior y esperar 10 minutos para generar uno nuevo. 🙂`,
      );
      return;
    }

    const confirmationMessage = response.replace('{{resumen}}', '').trim();
    if (confirmationMessage) {
      this.chatSocketService.sendMessage(`@${authorUsername} ${confirmationMessage}`);
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
        this.chatSocketService.sendMessage(`${prefix}${part}${suffix}`);
        if (i < resumenParts.length - 1) await this.utilsService.sleep(responseDelay);
      }

      await this.loggingService.saveEventsLog('Resumen', authorUsername);
      const clearedCount = await this.loggingService.clearMessagesLog();
      console.log(`✅ Resumen completado y log limpiado (${clearedCount} mensajes eliminados)`);
    } catch (error) {
      console.error('❌ Error generating summary:', error);
      this.chatSocketService.sendMessage('❌ Error al generar el resumen. Inténtalo más tarde.');
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

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

