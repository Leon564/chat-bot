import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatService } from '../chat/chat.service';
import { MusicService } from '../music/music.service';
import { AniListService, AniListResult } from '../anilist/anilist.service';
import { UtilsService } from '../../common/utils/utils.service';
import { LoggingService } from '../../common/utils/logging.service';
import { MemoryService } from '../../common/utils/memory.service';
import { ChatSocketService, ChatMessage } from '../chat-socket/chat-socket.service';
import { GraphIngestService } from '../graph/graph-ingest.service';

@Injectable()
export class BotService implements OnModuleInit {
  constructor(
    private readonly configService: ConfigService,
    private readonly chatService: ChatService,
    private readonly musicService: MusicService,
    private readonly aniListService: AniListService,
    private readonly utilsService: UtilsService,
    private readonly loggingService: LoggingService,
    private readonly memoryService: MemoryService,
    private readonly chatSocketService: ChatSocketService,
    private readonly graphIngestService: GraphIngestService,
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
    const { content, authorUsername, authorRole } = msg;
    if (!content || !authorUsername) return;

    // Los bots no interactúan entre ellos. Cualquier mensaje cuyo autor tenga
    // role 'bot' se ignora por completo — sin log, sin LLM, sin música — para
    // evitar bucles o ruido cruzado entre bots.
    if (authorRole === 'bot') return;

    const botUsername = this.chatSocketService.username ?? 'bot';

    await this.loggingService.saveLog(authorUsername, content);
    // Alimenta el grafo con TODO el tráfico, no solo lo dirigido al bot —
    // por eso va acá y no después del filtro de menciones de abajo.
    // Fire-and-forget: la ingesta es best-effort y no debe demorar la
    // respuesta al usuario ni, si falla, disparar el manejador de error que
    // le habla (este método no tiene un catch que hable al usuario, pero el
    // patrón se mantiene uniforme con los otros tres sitios de ingesta).
    void this.graphIngestService.ingestSocial(msg).catch(() => {});

    // Admin runtime command: switch the bot's personality without restarting.
    // Handled before the trigger gating so admins don't need to mention the
    // bot for the command to work.
    if (await this.handlePersonalityCommand(content, authorUsername, authorRole)) return;

    const containsExactBotName = (text: string): boolean =>
      new RegExp(`\\b${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);

    const containsBotWord = (text: string): boolean => /\bbot\b/i.test(text);

    // Responder a un mensaje del propio bot cuenta como interpelarlo, aunque el
    // texto no lo mencione. Con repliesEnabled=true el backend NO reescribe el
    // contenido con una mención, así que sin esto el bot ignoraría las
    // respuestas a sus propios mensajes. (Con replies desactivadas el contenido
    // ya llega con "<@bot>" y lo captura containsExactBotName.)
    const isReplyToBot =
      !!msg.replyTo && msg.replyTo.authorUsername?.toLowerCase() === botUsername.toLowerCase();

    const isMusicRequest = MusicService.isMusicRequest(content);
    const isOnlineReq = this.isOnlineUsersRequest(content);
    const videoEnabled = !!this.configService.get<boolean>('video.enabled');
    const isVideoReq = videoEnabled && MusicService.isVideoRequest(content);

    if (
      !isReplyToBot &&
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
    if (authorUsername === 'Sleepy Ash' && content.toLowerCase().includes('debug')) {
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
        this.sendBotMessage(result.text);
        if (result.track) {
          // Fire-and-forget: la ingesta es best-effort y no debe demorar
          // esta respuesta ni poder disparar el .catch() de abajo (que le
          // habla al usuario) si el grafo falla.
          void this.graphIngestService.ingestTrack(authorUsername, query, result.track).catch(() => {});
        }
      })
      .catch(async (error: Error) => {
        await this.utilsService.sleep(responseDelay);
        if (searchingId) this.chatSocketService.deleteMessage(searchingId);
        this.sendBotMessage(`@${authorUsername} ${this.friendlyMusicError(error, query)}`);
      });
  }

  // ─── AniList ───────────────────────────────────────────────────────────────

  private async handleAniListRequest(
    rawKind: string,
    rawTitle: string,
    authorUsername: string,
  ): Promise<void> {
    const kind = AniListService.normalizeKind(rawKind);
    const title = (rawTitle ?? '').trim();
    if (!kind || title.length < 1) {
      this.sendBotMessage(
        `@${authorUsername} 🤔 No entendí qué buscar en AniList (kind="${rawKind}", title="${rawTitle}").`,
      );
      return;
    }

    try {
      const result = await this.aniListService.search(kind, title);
      if (!result) {
        this.sendBotMessage(
          `@${authorUsername} 🔎 No encontré "${title}" en AniList. Probá con otro título.`,
        );
        return;
      }

      // Fire-and-forget: la ingesta es best-effort y no debe ni demorar el
      // armado de la tarjeta ni poder disparar el catch de abajo (que le
      // habla al usuario) si el grafo falla.
      void this.graphIngestService.ingestAniList(authorUsername, result, title).catch(() => {});

      // AniList sólo expone sinopsis en inglés; traducimos con el mismo modelo
      // OpenAI que ya usa el bot. Si la traducción falla, translateToSpanish
      // cae al texto original para no romper la tarjeta.
      const translatedDescription = result.description
        ? await this.chatService.translateToSpanish(result.description, authorUsername)
        : null;
      const localized: AniListResult = { ...result, description: translatedDescription };

      this.sendBotMessage(this.formatAniListCard(localized));
    } catch (err) {
      const code = (err as Error)?.message ?? '';
      if (code === 'RATE_LIMIT') {
        this.sendBotMessage(`@${authorUsername} ⏱️ AniList me está limitando. Probá en un minuto.`);
      } else if (code === 'NETWORK') {
        this.sendBotMessage(`@${authorUsername} 📡 No pude alcanzar AniList. Intentalo de nuevo en un rato.`);
      } else {
        this.sendBotMessage(`@${authorUsername} 😕 AniList no respondió bien esta vez.`);
      }
    }
  }

  private formatAniListCard(r: AniListResult): string {
    const kindLabel: Record<AniListResult['kind'], string> = {
      manga: 'Manga',
      manhwa: 'Manhwa',
      manhua: 'Manhua',
      anime: 'Anime',
    };
    const statusLabel: Record<string, string> = {
      FINISHED: 'Finalizado',
      RELEASING: 'En curso',
      NOT_YET_RELEASED: 'Aún no publicado',
      CANCELLED: 'Cancelado',
      HIATUS: 'En pausa',
    };
    // AniList sólo expone géneros en inglés. La lista de géneros es fija y
    // documentada — cubrimos los 18 oficiales con su traducción al español.
    // Si aparece uno que no esté mapeado, lo dejamos tal cual.
    const genreLabel: Record<string, string> = {
      Action: 'Acción',
      Adventure: 'Aventura',
      Comedy: 'Comedia',
      Drama: 'Drama',
      Ecchi: 'Ecchi',
      Fantasy: 'Fantasía',
      Hentai: 'Hentai',
      Horror: 'Terror',
      'Mahou Shoujo': 'Mahou Shoujo',
      Mecha: 'Mecha',
      Music: 'Música',
      Mystery: 'Misterio',
      Psychological: 'Psicológico',
      Romance: 'Romance',
      'Sci-Fi': 'Ciencia ficción',
      'Slice of Life': 'Slice of Life',
      Sports: 'Deportes',
      Supernatural: 'Sobrenatural',
      Thriller: 'Suspenso',
    };

    const title = r.titleEnglish && r.titleEnglish !== r.titleRomaji
      ? `${r.titleRomaji} (${r.titleEnglish})`
      : r.titleRomaji;

    const cover = r.coverImage ? `[img]${r.coverImage}[/img]` : '';

    const facts: string[] = [`**${kindLabel[r.kind]}**`];
    if (r.status && statusLabel[r.status]) facts.push(statusLabel[r.status]);
    else if (r.status) facts.push(r.status.toLowerCase());
    if (r.score) facts.push(`⭐ ${r.score}/100`);
    if (r.startYear) facts.push(`${r.startYear}`);

    const counts: string[] = [];
    if (r.kind === 'anime') {
      if (r.episodes) counts.push(`📺 ${r.episodes} eps`);
    } else {
      if (r.chapters) counts.push(`📖 ${r.chapters} caps`);
      if (r.volumes) counts.push(`📚 ${r.volumes} vols`);
    }

    const translatedGenres = r.genres.slice(0, 5).map((g) => genreLabel[g] ?? g);
    const genres = translatedGenres.length > 0 ? `🏷️ ${translatedGenres.join(', ')}` : '';

    const synopsis = this.truncate(r.description ?? '', 320);

    const parts: string[] = [
      cover,
      `**${title}**`,
      facts.join(' · '),
      counts.join(' · '),
      genres,
      synopsis,
      `🔗 ${r.url}`,
    ];

    return parts.filter((p) => p && p.length > 0).join('\n');
  }

  private truncate(text: string, max: number): string {
    if (!text) return '';
    const clean = text.replace(/\s+\n/g, '\n').trim();
    if (clean.length <= max) return clean;
    const cut = clean.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > max * 0.7 ? cut.slice(0, lastSpace) : cut).trim() + '…';
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
        this.sendBotMessage(result.text);
        if (result.track) {
          // Fire-and-forget: la ingesta es best-effort y no debe demorar
          // esta respuesta ni poder disparar el .catch() de abajo (que le
          // habla al usuario) si el grafo falla.
          void this.graphIngestService.ingestTrack(authorUsername, query, result.track).catch(() => {});
        }
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

    // Music intent tokens: the LLM decides when a message is a music request
    // and emits {{music:<query>}} alongside its confirmation. The user can ask
    // for several songs at once, so we collect ALL tokens, send the
    // confirmation stripped of every token, then dispatch each query through
    // the same pipeline as the !music fast-path.
    const musicRe = /\{\{music:\s*([^}]+?)\s*\}\}/gi;
    const musicTokens = [...response.matchAll(musicRe)];
    if (musicTokens.length > 0) {
      const queries = musicTokens
        .map((m) => m[1].trim())
        .filter((q) => q.length >= 2);
      const confirmText = response.replace(musicRe, '').replace(/\s{2,}/g, ' ').trim();
      if (confirmText) {
        this.sendBotMessage(`@${authorUsername} ${confirmText}`);
        await this.utilsService.sleep(responseDelay);
      }
      for (const query of queries) {
        await this.handleMusicRequest(`!music ${query}`, authorUsername);
      }
      return;
    }

    // AniList intent tokens: the LLM emits {{anilist:<kind>:<title>}} when the
    // user asks for info about a specific manga/manhwa/manhua/anime. We collect
    // every token, send the confirmation text without tokens, then resolve each
    // one against AniList and post the card. Same multi-query approach as music
    // so the LLM can answer "buscame X y Y" in a single turn.
    const anilistRe = /\{\{anilist:\s*([^:}]+?)\s*:\s*([^}]+?)\s*\}\}/gi;
    const anilistTokens = [...response.matchAll(anilistRe)];
    if (anilistTokens.length > 0) {
      const confirmText = response.replace(anilistRe, '').replace(/\s{2,}/g, ' ').trim();
      if (confirmText) {
        this.sendBotMessage(`<@${authorUsername}> ${confirmText}`);
        await this.utilsService.sleep(responseDelay);
      }
      for (const token of anilistTokens) {
        await this.handleAniListRequest(token[1], token[2], authorUsername);
        await this.utilsService.sleep(responseDelay);
      }
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
      const resumen = await this.chatService.generateSummary(authorUsername);
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


  // ─── Personality command (admins) ────────────────────────────────────────

  /**
   * Recognize and execute the `!personality` admin command. Returns true when
   * the message was a personality command (handled or rejected) so the caller
   * can short-circuit the rest of the dispatcher. Regex-based to avoid
   * spending an LLM call on what is unambiguous text.
   */
  private async handlePersonalityCommand(
    content: string,
    authorUsername: string,
    authorRole?: string,
  ): Promise<boolean> {
    const match = content.trim().match(/^!(?:personality|persona|personalidad)(?:\s+(\w+))?\s*$/i);
    if (!match) return false;

    const sub = (match[1] ?? 'status').toLowerCase();

    if (authorRole !== 'admin' && authorRole !== 'superAdmin') {
      this.sendBotMessage(`@${authorUsername} ❌ Solo admins pueden cambiar la personalidad.`);
      return true;
    }

    if (sub === 'default' || sub === 'unfiltered') {
      this.chatService.setPersonalityOverride(sub);
      this.sendBotMessage(`@${authorUsername} ✅ Personalidad cambiada a "${sub}".`);
      console.log(`🎭 [PERSONALITY] ${authorUsername} → ${sub}`);
      return true;
    }

    if (sub === 'reset' || sub === 'env') {
      this.chatService.setPersonalityOverride(null);
      const info = this.chatService.getPersonalityInfo();
      this.sendBotMessage(
        `@${authorUsername} ↩️ Personalidad reseteada al valor del .env: "${info.current}".`,
      );
      console.log(`🎭 [PERSONALITY] ${authorUsername} → reset (.env: ${info.current})`);
      return true;
    }

    if (sub === 'status') {
      const info = this.chatService.getPersonalityInfo();
      const note = info.source === 'override' ? ' (override en runtime)' : ' (del .env)';
      this.sendBotMessage(`@${authorUsername} 🎭 Personalidad actual: "${info.current}"${note}.`);
      return true;
    }

    this.sendBotMessage(
      `@${authorUsername} Uso: !personality default | unfiltered | reset | status`,
    );
    return true;
  }

  /**
   * Detect requests for the *full list* of online users. Earlier this matched
   * single bare keywords like "online" or "conectados", which falsely fired
   * on questions like "está el admin online?" — those are about ONE user, not
   * the list. The current matcher requires multi-word phrases that clearly
   * imply listing or counting, and a guard rejects singular questions
   * targeted at a specific user.
   */
  private isOnlineUsersRequest(message: string): boolean {
    if (!message || typeof message !== 'string') return false;
    const lower = message
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, ''); // strip accents so linea/línea both match

    // Reject questions about a specific user, e.g. "está el admin online?",
    // "esta neru conectado?", "donde anda kei?". Singular "está/esta" + person
    // reference is a clear signal it isn't a roster request.
    const singularUserQuestion =
      /\b(esta|donde\s+(esta|anda)|sabes\s+si)\s+(el|la|los|las)?\s*\w+\s+(online|en\s+linea|conectad[ao]s?|disponible)/.test(lower) ||
      /\b(esta|donde\s+anda)\s+@?\w+\s*\??$/.test(lower);
    if (singularUserQuestion) return false;

    const patterns: RegExp[] = [
      // "quién/quiénes está/están (en línea|online|conectado)"
      /\bquien(es)?\s+(esta|estan|anda|andan|hay)\s+(en\s+(la\s+)?(linea|chat|sala)|online|conectad)/,
      // "(usuarios|gente|personas) (online|en línea|conectados|activos)"
      /\b(usuarios?|gente|personas?|miembros|raza)\s+(en\s+(la\s+)?(linea|sala|chat)|online|conectad|activ)/,
      // "(cuántos|cuántas) (están|hay|usuarios|personas)"
      /\bcuant[oa]s\s+(estan|hay|usuarios?|personas?|gente|online|conectad)/,
      // "(lista|listar|ver|mostrar|muéstrame) (de) (usuarios|gente|conectados|online)"
      /\b(lista|listar|listame|mostrar|muestrame|ver|enseñame)\s+(la\s+)?(de\s+)?(usuarios?|gente|conectad|online|quien|personas?)/,
      // English variants
      /\b(who('?s|\s+is)\s+online|online\s+users|users\s+online|list\s+(of\s+)?users)/,
      // "quién más está aquí" / "quién anda por aquí"
      /\bquien(es)?\s+(mas\s+)?(esta|estan|anda|andan)\s+(aqui|por\s+aqui|en\s+(la\s+)?(sala|chat))/,
    ];

    return patterns.some((re) => re.test(lower));
  }
}

