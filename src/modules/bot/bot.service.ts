import { Injectable, Logger, OnModuleInit, Optional, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatService } from '../chat/chat.service';
import { MusicService } from '../music/music.service';
import { AniListService, AniListResult } from '../anilist/anilist.service';
import { UtilsService } from '../../common/utils/utils.service';
import { LoggingService } from '../../common/utils/logging.service';
import { ChatSocketService, ChatMessage } from '../chat-socket/chat-socket.service';
import { GraphIngestService } from '../graph/graph-ingest.service';
import { GraphCacheService } from '../graph/graph-cache.service';
import { GraphService, Candidate, MAX_CANDIDATES, MIN_CANDIDATES } from '../graph/graph.service';
import { UsageService } from '../chat/usage.service';
import { RateLimitService } from './rate-limit.service';
import { StickerGateService } from './sticker-gate.service';
import { ProactiveService } from './proactive.service';
import { PollService } from './poll.service';
import { ReminderService } from '../chat/reminder.service';
import { MusicQuotaService, MusicAdmission } from './music-quota.service';
import { MusicIntentService } from './music-intent.service';
import { BotOutputService } from './bot-output.service';
import { BotCommandsService, formatRemaining } from './bot-commands.service';
import { StickerCatalogService } from '../chat-socket/sticker-catalog.service';
import { BbcodeSettingsService } from '../chat-socket/bbcode-settings.service';
import { INSTRUCTION_STAFF_ROLES } from '../chat/room-instructions.service';

import { bbcodeToPlain } from '../../common/bbcode/bbcode';
import { CrossContextSettingsService } from '../../common/settings/cross-context-settings.service';
import { VideoSettingsService } from '../../common/settings/video-settings.service';
import { ErrandService } from '../graph/errand.service';
import { FollowupService } from '../memory/followup.service';
import { MemorySettingsService } from '../memory/memory-settings.service';
import { MEMORY_ROLES } from '../memory/memory.types';
import { BotMemoryDocument } from '../../common/schemas/bot-memory.schema';
import { MusicProgress } from '../../common/interfaces';
import { createLog } from '../../common/utils/log';

// Re-export: los tests lo importaban de acá antes de que existiera BotCommandsService.
export { formatRemaining };

const log = createLog('BotService');

/**
 * Mensaje fijo cuando `RateLimitService.check` rechaza a alguien. Corto y
 * estático a propósito: no llama al modelo para generarlo (eso sería pagar
 * tokens justo para avisar que no hay más tokens para esa persona).
 */
const RATE_LIMITED_MESSAGE = '⏳ Estás mandando mensajes muy seguido. Esperá un poco antes de volver a escribirme.';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  /** Cada cuánto se revisan los recordatorios vencidos. */
  static readonly REMINDER_TICK_MS = 30_000;
  private reminderTimer: NodeJS.Timeout | null = null;

  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly chatService: ChatService,
    private readonly musicService: MusicService,
    private readonly aniListService: AniListService,
    private readonly utilsService: UtilsService,
    private readonly loggingService: LoggingService,
    private readonly chatSocketService: ChatSocketService,
    private readonly graphIngestService: GraphIngestService,
    private readonly graphCacheService: GraphCacheService,
    private readonly graphService: GraphService,
    private readonly usageService: UsageService,
    private readonly rateLimitService: RateLimitService,
    private readonly crossContextSettings: CrossContextSettingsService,
    private readonly errandService: ErrandService,
    private readonly stickerCatalog: StickerCatalogService,
    private readonly stickerGate: StickerGateService,
    private readonly output: BotOutputService,
    private readonly commands: BotCommandsService,
    // Opcional: sin él (los tests que arman el servicio a mano) se asumen
    // todos los BBCodes encendidos y el prompt no lleva sección de formato.
    @Optional() private readonly bbcodeSettings?: BbcodeSettingsService,
    // Opcional para los tests armados a mano: sin él la música no tiene topes.
    @Optional() private readonly musicQuota?: MusicQuotaService,
    // Opcional igual: sin él, "reproduce X" sin nombrar al bot no se atiende.
    @Optional() private readonly musicIntent?: MusicIntentService,
    // Opcional igual: sin él, el bot nunca comenta sin que lo nombren.
    @Optional() private readonly proactive?: ProactiveService,
    @Optional() private readonly reminders?: ReminderService,
    @Optional() private readonly polls?: PollService,
    // Opcional para los tests armados a mano: sin él manda VIDEO_ENABLED del .env.
    @Optional() private readonly videoSettings?: VideoSettingsService,
    // Memoria a largo plazo: sin estos dos (tests armados a mano) no hay memoria.
    @Optional() private readonly followups?: FollowupService,
    @Optional() private readonly memorySettings?: MemorySettingsService,
  ) {}

  onModuleDestroy() {
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    this.reminderTimer = null;
  }

  /**
   * Manda los recordatorios vencidos (los reclama de a uno en Mongo, así que
   * un tick que se pisa con otro no duplica). Si el bot estuvo caído, salen
   * tarde con una disculpa.
   */
  async deliverDueReminders(now = new Date()): Promise<void> {
    if (this.reminders) {
      const due = await this.reminders.claimDue(now);
      for (const r of due) {
        const late = now.getTime() - new Date(r.dueAt).getTime() > 10 * 60_000 ? ' (perdón la demora)' : '';
        this.sendBotMessage(`⏰ <@${r.username}> te recuerdo: ${r.text}${late}`);
        this.logOwnMessage(this.chatSocketService.username ?? '', `te recuerdo: ${r.text}`, r.username);
      }
    }
    // Suerte del día de los eventos que Aria recordó (memoria a largo plazo).
    if (this.followups && this.memorySettings?.isEnabled()) {
      const due = await this.followups.claimDueBefore(now);
      for (const { user, memory } of due) {
        await this.sendFollowUp(memory, user, this.chatSocketService.username ?? '', 'before');
      }
    }
  }

  /** La memoria aplica a esta persona: encendida y registrada. */
  private memoryOnFor(role: string | undefined): boolean {
    return !!this.followups && !!this.memorySettings?.isEnabled() && !!role && MEMORY_ROLES.has(role);
  }

  /** Manda un seguimiento como mensaje propio, con la voz de Aria o un texto fijo de respaldo. */
  private async sendFollowUp(
    memory: BotMemoryDocument,
    user: string,
    botUsername: string,
    phase: 'before' | 'after',
  ): Promise<void> {
    const drafted = await this.chatService.draftFollowUp(botUsername, user, memory.text, phase).catch(() => '');
    const what = memory.text.charAt(0).toLowerCase() + memory.text.slice(1);
    const text =
      BotService.stripIntentTokens(drafted) ||
      (phase === 'before' ? `¡hoy es el día! Suerte con lo de ${what} 🍀` : `¿cómo te fue con lo de ${what}?`);
    this.sendBotMessage(`<@${user}> ${text}`);
    this.logOwnMessage(botUsername, text, user);
  }

  async onModuleInit() {
    log.info('🤖 Inicializando Bot Service...');

    // El socket no espera al handler, así que un rechazo acá era una promesa
    // flotante: `main.ts` corta el proceso ante cualquier `unhandledRejection`,
    // y un parpadeo de Mongo en `saveLog` (que corre en CADA mensaje)
    // reiniciaba el bot. Se loguea y se sigue con el próximo mensaje.
    this.chatSocketService.onMessage((msg) => {
      this.handleNewChatMessage(msg).catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        this.logger.error(`Error manejando el mensaje de ${msg?.authorUsername ?? '?'}: ${e.message}`, e.stack);
      });
    });

    // Votos de las encuestas: el backend difunde cada cambio de reacciones.
    this.chatSocketService.onReactionUpdate?.((messageId, reactions) => this.polls?.onReactions(messageId, reactions));

    if (this.reminders || this.followups) {
      this.reminderTimer = setInterval(() => {
        void this.deliverDueReminders().catch(() => {});
      }, BotService.REMINDER_TICK_MS);
      this.reminderTimer.unref?.();
    }
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

    // El nombre propio del bot no se conoce hasta que el backend responde la
    // autenticación, así que `ErrandService` no puede leerlo de la config: se
    // lo pasamos acá, donde ya está resuelto, para que pueda hacer cumplir
    // "el bot no puede ser destinatario de un recado" en el punto donde
    // escribe la fila (revisión final de rama, deuda #3). Sólo cuando el
    // socket lo sabe de verdad: el `?? 'bot'` de arriba es un fallback para
    // los regex de mención, y usarlo acá haría que un usuario que se llame
    // literalmente "bot" no pudiera recibir recados.
    if (this.chatSocketService.username) {
      this.errandService.setBotName(this.chatSocketService.username);
    }

    // El log alimenta el resumen, que sale al chat en público: sin formato y
    // con los spoilers tapados.
    // Los stickers van por su nombre ("[sticker: Gato llorando]"): el log lo
    // leen el resumen y el contexto de sala, y ":stk_x:" no le dice nada al
    // modelo.
    await this.loggingService.saveLog(
      authorUsername,
      bbcodeToPlain(this.stickerCatalog.describeContent(content, msg.type), 'hide'),
    );
    // Alimenta el grafo con TODO el tráfico, no solo lo dirigido al bot —
    // por eso va acá y no después del filtro de menciones de abajo.
    // Fire-and-forget: la ingesta es best-effort y no debe demorar la
    // respuesta al usuario ni, si falla, disparar el manejador de error que
    // le habla (este método no tiene un catch que hable al usuario, pero el
    // patrón se mantiene uniforme con los otros tres sitios de ingesta).
    void this.graphIngestService.ingestSocial(msg).catch(() => {});

    // Comandos `!…` (BotCommandsService): van antes del filtro de menciones
    // —no hace falta nombrar al bot— y antes de la entrega de recados, para
    // que `!rechazarrecados` no dispare justo el recado que se quiere borrar.
    if (await this.commands.handle(content, authorUsername, authorRole)) return;

    // `!resumen [2h|hoy]` funciona sin nombrar al bot, como los demás comandos.
    if (/^\s*!resumen\b/i.test(content)) {
      await this.tryPeriodSummary(content, authorUsername, false);
      return;
    }

    // Entrega de recados. Va antes del filtro de menciones a propósito: el
    // caso de uso es justamente que Lyna aparezca diciendo "hola gente" sin
    // dirigirse al bot. Con el filtro delante, el recado no se entregaría
    // nunca — que es exactamente lo que le pasa a la nota de regreso de la
    // fase 5b, documentado y todavía sin arreglar.
    //
    // Revisión de código (Important #1): la entrega en sí SIEMPRE se intenta
    // acá, incondicional — pero ya NO decide por su cuenta si el dispatcher
    // corta (antes: `if (await this.deliverPendingErrand(...)) return;`).
    // El mensaje que dispara la entrega puede A LA VEZ interpelar al bot
    // (una mención, un pedido de música) — verificado ejecutando con
    // `content: 'bot como va'` y un recado pendiente: `chatService.chat`
    // recibía 0 llamadas y la pregunta real desaparecía en silencio detrás
    // del recado ajeno. Cortar o no cortar es SIEMPRE la misma decisión que
    // ya tomaba el filtro de mención de más abajo (`isReplyToBot` /
    // `containsBotWord` / … `isVideoReq`) — la entrega no le agrega una
    // razón nueva para cortar, sólo se monta encima sin cambiar esa
    // decisión.
    await this.deliverPendingErrand(authorUsername, botUsername);

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

    // `!music` funciona sin nombrar al bot; una frase natural ("reproduce X")
    // sólo si el mensaje le habla al bot. Antes cualquier mensaje con
    // "reproduce" o "tema de" disparaba una descarga.
    const addressesBot = isReplyToBot || containsBotWord(content) || containsExactBotName(content);
    const isMusicRequest =
      MusicService.isMusicRequest(content) && (/^\s*!music\s/i.test(content) || addressesBot);
    // Igual que con la música: una pregunta que nombra el chat ("¿quién está en
    // línea?", "¿cuántos hay conectados?") se atiende sin mención, pero una
    // ambigua ("¿cuántas personas fueron al concierto?", "la gente activa del
    // gym") sólo si le hablan al bot. Antes cualquiera de las dos publicaba la
    // lista de conectados.
    const onlineCandidate = this.isOnlineUsersRequest(content);
    const isOnlineReq = onlineCandidate && (addressesBot || BotService.mentionsChatPresence(content));
    const videoEnabled = this.videoSettings
      ? this.videoSettings.isEnabled()
      : !!this.configService.get<boolean>('video.enabled');
    const isVideoReq = videoEnabled && MusicService.isVideoRequest(content);

    // Sin nombrar al bot, "reproduce X" sólo cuenta si el clasificador local
    // (verbo al principio, sin señales de charla, o canción/artista conocido
    // en el grafo) lo da por pedido. Ver MusicIntentService.
    let intentQuery: string | null = null;
    if (!isMusicRequest && !addressesBot && !isVideoReq && this.musicIntent) {
      const intent = await this.musicIntent.classify(content);
      if (intent?.isRequest) intentQuery = intent.query;
    }

    if (
      !isReplyToBot &&
      !containsBotWord(content) &&
      !containsExactBotName(content) &&
      !isMusicRequest &&
      !intentQuery &&
      !isOnlineReq &&
      !isVideoReq
    ) {
      // No le hablaron. Si Aria tiene un "¿cómo te fue?" pendiente para esta
      // persona, es el momento (apareció); si no, a lo sumo un comentario
      // espontáneo cada tanto (sin await: sus fallos se tragan adentro).
      if (this.memoryOnFor(authorRole)) {
        const after = await this.followups!.claimAfter(authorUsername).catch(() => null);
        if (after) {
          await this.sendFollowUp(after, authorUsername, botUsername, 'after');
          return;
        }
      }
      void this.maybeChimeIn(content, botUsername).catch(() => {});
      return;
    }

    log.info(`📨 Mensaje de ${authorUsername}: "${content}"`);

    if (isVideoReq) {
      await this.handleVideoRequest(content, authorUsername, authorRole);
      return;
    }

    if (isMusicRequest) {
      await this.handleMusicRequest(content, authorUsername, authorRole);
      return;
    }

    if (intentQuery) {
      await this.handleMusicRequest(`!music ${intentQuery}`, authorUsername, authorRole);
      return;
    }

    if (isOnlineReq) {
      await this.handleOnlineUsersRequest(authorUsername);
      return;
    }

    // Resumen de un período ("!resumen 2h", "bot resumen de hoy"): sin pasar
    // por el modelo para decidir, va directo al resumen.
    if (await this.tryPeriodSummary(content, authorUsername, addressesBot)) return;

    // "bot recordame en 2h que…": se entiende en código, sin modelo. Si la
    // hora no se entiende, sigue al modelo como cualquier mensaje.
    if (this.reminders && addressesBot && ReminderService.isReminderRequest(content)) {
      const parsed = ReminderService.parse(content, new Date(), botUsername);
      if (parsed) {
        await this.commands.createReminderFor(authorUsername, parsed.text, parsed.dueAt);
        return;
      }
    }

    // Debug commands (owner only)
    // Por rol y no por nombre: antes sólo respondía al nombre exacto
    // 'Sleepy Ash', fijo en el código.
    if ((authorRole === 'admin' || authorRole === 'superAdmin') && content.toLowerCase().includes('debug')) {
      const qs = this.musicService.getQueueStatus();
      this.sendBotMessage(`@${authorUsername} Debug: Procesando=${qs.isProcessing}, Cola=${qs.queueLength} 🎵`);
      return;
    }

    // Guard de costo por usuario (Task 4, fase 5a): va acá, INMEDIATAMENTE
    // antes de la única llamada al modelo del dispatcher normal — no al
    // principio del método. Los fast-paths de arriba (música, video, usuarios
    // online) y los tres comandos (!personality, !quesabes, !olvida) ya
    // cortaron antes si aplicaban, y ninguno de ellos cuesta tokens: limitarlos
    // sería peor que no limitar nada.
    if (!this.rateLimitService.check(authorUsername, authorRole)) {
      // Revisión final (Important #2): avisar en CADA mensaje rechazado abre
      // un canal de flood gratuito — el bot corre con `role=bot`, que
      // bypasea el anti-spam del gateway, así que nada del otro lado frena a
      // alguien pasado de cupo que siga escribiendo. `shouldNotifyRejection`
      // deja pasar un aviso por ventana de cooldown y calla el resto — nunca
      // silencio total, porque la persona no entendería por qué el bot la
      // empezó a ignorar.
      if (this.rateLimitService.shouldNotifyRejection(authorUsername)) {
        this.sendBotMessage(`@${authorUsername} ${RATE_LIMITED_MESSAGE}`);
      }
      return;
    }

    // Si el mensaje responde a otro, el modelo necesita ese otro mensaje para
    // entender de qué se habla ("bot qué opinás?" sobre lo que dijo alguien).
    const replyContext = this.chatSocketService.getReplyContext(msg);
    // Los stickers llegan al modelo por su nombre ("[sticker: Gato llorando]")
    // en vez de ":stk_xxxxx:", así puede reaccionar a ellos con sentido.
    // El BBCode del usuario llega limpio (`[b]x[/b]` → `x`, spoilers como
    // `(spoiler: …)`).
    const modelText = bbcodeToPlain(this.stickerCatalog.describeContent(content, msg.type), 'mark');
    const stickers = this.buildStickerOffer(content, msg.type);
    const bbcodes = this.bbcodeSettings?.enabled();
    // Memoria a largo plazo: si hay un "¿cómo te fue?" pendiente, va dentro de
    // esta misma respuesta (un solo mensaje) en vez de un mensaje aparte.
    const memoryOn = this.memoryOnFor(authorRole);
    const followUp = memoryOn ? await this.followups!.claimAfter(authorUsername).catch(() => null) : null;
    const chatOptions = {
      ...(replyContext ? { replyTo: replyContext } : {}),
      ...(stickers ? { stickers } : {}),
      ...(bbcodes && bbcodes.length > 0 ? { bbcodes } : {}),
      ...(authorRole && INSTRUCTION_STAFF_ROLES.has(authorRole) ? { canInstruct: true } : {}),
      // Reaccionar necesita el id del mensaje y el flag del admin.
      ...(msg._id && this.chatSocketService.reactionsEnabled ? { reactions: true } : {}),
      ...(memoryOn ? { memory: followUp ? { followUp: followUp.text } : {} } : {}),
    };
    // "<bot> está escribiendo…" mientras el modelo piensa. El `?.` es por los
    // dobles de los tests, que no traen el método.
    const stopTyping = this.chatSocketService.startTyping?.() ?? (() => {});
    let rawResponse: string;
    try {
      rawResponse = Object.keys(chatOptions).length > 0
        ? await this.chatService.chat(modelText, botUsername, authorUsername, chatOptions)
        : await this.chatService.chat(modelText, botUsername, authorUsername);
    } finally {
      stopTyping();
    }
    const { text: afterSticker, sticker } = this.takeStickerToken(rawResponse);
    const { text: response, reaction } = this.takeReactToken(afterSticker);
    if (!response && !sticker && !reaction) return;

    // La reacción va primero: es instantánea y no compite con el texto.
    if (reaction) {
      this.chatSocketService.toggleReaction(msg._id, reaction);
      log.info(`💬 Reacción ${reaction} al mensaje de ${authorUsername}`);
    }

    // El sticker va en el MISMO mensaje que el texto (`:code:` al final; el
    // chat lo dibuja en línea), y sólo en respuestas de charla: en una de
    // música, AniList, resumen o usuarios online el token del flujo (`{{...}}`)
    // manda y un sticker encima sería ruido.
    const withSticker = sticker && !/\{\{/.test(response);
    const outgoing = withSticker ? `${response} :${sticker.code}:`.trim() : response;
    if (outgoing) await this.handleChatResponse(outgoing, authorUsername, authorRole);
    if (!response.includes('{{resumen}}')) {
      this.logOwnMessage(botUsername, withSticker ? `${response} [sticker: ${sticker.name}]` : response, authorUsername);
    }
    if (withSticker) {
      this.stickerGate.markSent();
      log.info(`🧩 Sticker enviado: ${sticker.name}`);
    }

    // Fire-and-forget, con su propio catch, como el resto de la ingesta al
    // grafo: marca qué candidatas de la recomendación colaborativa (Task 3,
    // fase 5b) terminaron de verdad mencionadas en la respuesta del modelo.
    // SÓLO se marcan esas — marcar de más significa no volver a ofrecer algo
    // bueno; marcar de menos significa repetirse.
    void this.markCollaborativeRecommendations(authorUsername, response).catch(() => {});
  }

  // ─── Stickers ──────────────────────────────────────────────────────────────

  /** Oferta de sticker para esta respuesta, o null si no corresponde. */
  private buildStickerOffer(content: string, type?: string): { list: string; requested: boolean } | null {
    if (this.stickerCatalog.size === 0) return null;
    const stickerOnly = this.stickerCatalog.isOnlyStickers(content, type);
    const decision = this.stickerGate.decide(content, { stickerOnly });
    if (decision === 'none') return null;
    return { list: this.stickerCatalog.promptList(), requested: decision === 'requested' };
  }

  /**
   * Separa el `{{sticker:nombre}}` que devuelve ChatService y lo resuelve
   * contra el catálogo. Un nombre que no existe se descarta en silencio: es
   * preferible no mandar nada a mandar un sticker equivocado.
   */
  /** Saca `{{react:emoji}}` (lo arma `ChatService` sólo si se ofreció reaccionar). */
  private takeReactToken(response: string): { text: string; reaction: string | null } {
    const re = /\{\{react:\s*([^}]+?)\s*\}\}/gi;
    const match = re.exec(response ?? '');
    if (!match) return { text: response ?? '', reaction: null };
    const text = response.replace(re, '').replace(/[ \t]{2,}/g, ' ').trim();
    return { text, reaction: match[1] };
  }

  private takeStickerToken(response: string): {
    text: string;
    sticker: { code: string; name: string } | null;
  } {
    const re = /\{\{sticker:\s*([^}]+?)\s*\}\}/gi;
    const match = re.exec(response ?? '');
    if (!match) return { text: response ?? '', sticker: null };
    const text = response.replace(re, '').replace(/[ \t]{2,}/g, ' ').trim();
    const found = this.stickerCatalog.findByName(match[1]);
    if (!found) log.info(`🧩 El modelo eligió un sticker que no existe: "${match[1]}"`);
    return { text, sticker: found ? { code: found.code, name: found.name } : null };
  }

  // ─── Recomendación colaborativa (Task 3, fase 5b) ──────────────────────────

  /**
   * Tras responder, revisa cuáles de las candidatas de
   * `GraphService.collaborative` aparecen mencionadas en el TEXTO que el
   * modelo generó (la misma respuesta que ya se envió) y las marca con
   * `recommended_to` — es lo único que evita que el bot vuelva a sugerir lo
   * mismo la próxima vez (`collaborative` excluye lo ya marcado).
   *
   * Deliberadamente vuelve a consultar `collaborative` en vez de reutilizar
   * las candidatas que `GraphContextService.build` ya calculó para el mismo
   * turno: encadenar ese valor implicaría cambiar el tipo de retorno de
   * `ChatService.chat()` (hoy `Promise<string>`) y el de
   * `GraphContextService.build()` (hoy también `Promise<string>`) — no sólo
   * en su único llamador productivo de cada uno, sino en sus specs (~13
   * sitios en `chat.service.spec.ts` y ~20 en `graph-context.service.spec.ts`
   * leen el resultado como texto plano). Se evaluó ese cambio y se decidió
   * NO forzarlo por ese costo — ver el reporte de la Task 3 (ronda de
   * corrección 1) para el detalle. La segunda lectura a Mongo es el precio
   * de mantener esas firmas intactas.
   *
   * Esto sí tiene una consecuencia real, no sólo de costo: entre la lectura
   * que ve `GraphContextService.build` y esta hay un `await` a la llamada al
   * modelo (puede tardar varios segundos), y en ese hueco otro mensaje del
   * mismo usuario podría escribir en `bot_edges` (un `likes` nuevo, otra
   * recomendación ya marcada). La lista que ve esta función puede entonces
   * diferir levemente de la que vio el modelo — no hay ninguna garantía de
   * "misma lista" acá. Es inofensivo de todos modos: en el peor caso se
   * marca (o se deja de marcar) una candidata puntual con ese desfasaje de
   * por medio, nunca se corrompe nada, porque `findNode`/`upsertEdge` siguen
   * resolviendo contra el estado real del grafo en el momento en que corren.
   *
   * La comparación es por `label` normalizado (minúsculas, sin acentos, vía
   * `GraphService.normalizeKey`) contra el texto de la respuesta, exigiendo
   * un límite de palabra real (ver `mentionedCandidates`) — no hace falta
   * resolver alias: el label es tal como se lo mostramos al modelo en la
   * línea de contexto, así que si lo menciona, lo hace con ese mismo texto
   * (o una variación de mayúsculas/acentos que la normalización ya cubre).
   */
  private async markCollaborativeRecommendations(
    authorUsername: string,
    response: string,
  ): Promise<void> {
    const userNode = await this.graphService.findNode('user', authorUsername);
    if (!userNode) return;

    const candidates = await this.graphService.collaborative(userNode._id, MAX_CANDIDATES);
    // Mismo umbral que decide si `GraphContextService.render` las muestra en
    // la línea de contexto (`MIN_CANDIDATES`) — no un tope propio. Si
    // divergieran, con menos candidatas que ese umbral el modelo nunca las
    // vio en el prompt, y cualquier mención incidental (una pregunta factual
    // sobre esa obra, no una recomendación) marcaría recommended_to para
    // siempre algo que nadie llegó a ofrecer de verdad.
    if (candidates.length < MIN_CANDIDATES) return;

    const mentioned = this.mentionedCandidates(response, candidates);

    for (const candidate of mentioned) {
      const node = await this.graphService.findNode('work', candidate.key);
      if (!node) continue;
      await this.graphService.upsertEdge({
        from: userNode._id,
        to: node._id,
        type: 'recommended_to',
        source: 'signal',
      });
    }
  }

  /**
   * De las candidatas de `collaborative`, cuáles aparecen de verdad en el
   * texto de la respuesta — exigiendo que la coincidencia caiga en un límite
   * de palabra real, no una subcadena cualquiera. `includes()` a secas marca
   * de más, y marcar de más es el error más caro de los dos (significa no
   * volver a ofrecer una buena recomendación, en silencio y para siempre):
   *
   * - "Air" es prefijo de "aire": sin límite de palabra, cualquier respuesta
   *   que use la palabra "aire" marcaría la candidata "Air" (anime real de
   *   Key) sin que el modelo la haya mencionado.
   * - "Fate" es subcadena de "Fate/Zero" — y acá el límite de palabra NO
   *   alcanza por sí solo: "/" también cuenta como límite de palabra para
   *   una regex `\b`-like, así que "fate" matchea igual dentro de
   *   "fate/zero". Por eso las candidatas se evalúan de la más larga a la
   *   más corta, y el texto que ya matcheó una candidata larga se CONSUME
   *   (se reemplaza por un espacio) antes de probar las más cortas: si el
   *   modelo sólo escribió "Fate/Zero", esa aparición deja de estar
   *   disponible para que "Fate" la vuelva a matchear por su cuenta. Si
   *   "Fate" aparece en OTRO lugar del texto, separado de esa aparición,
   *   sigue contando — sólo se consume la porción exacta ya atribuida a la
   *   candidata más larga, no todas las apariciones de la palabra.
   */
  private mentionedCandidates(response: string, candidates: Candidate[]): Candidate[] {
    const byLabelLengthDesc = [...candidates].sort(
      (a, b) =>
        this.graphService.normalizeKey(b.label).length - this.graphService.normalizeKey(a.label).length,
    );

    let remaining = this.graphService.normalizeKey(response);
    const mentioned: Candidate[] = [];

    for (const candidate of byLabelLengthDesc) {
      const needle = this.graphService.normalizeKey(candidate.label);
      if (!needle) continue;

      // Mismo escape que ya usa `containsExactBotName` más arriba en este
      // archivo, para el mismo propósito: el label puede traer caracteres
      // especiales de regex (p. ej. el "/" de "Fate/Zero").
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Límite de palabra manual con lookbehind/lookahead Unicode en vez de
      // `\b`: el comportamiento es el mismo para este alfabeto (ya pasado
      // por `normalizeKey`), pero deja explícito qué cuenta como "letra u
      // dígito" sin depender de la definición ASCII de `\w`.
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');
      const match = pattern.exec(remaining);
      if (!match) continue;

      mentioned.push(candidate);
      remaining = remaining.slice(0, match.index) + ' ' + remaining.slice(match.index + match[0].length);
    }

    return mentioned;
  }

  // ─── Music ─────────────────────────────────────────────────────────────────

  private async handleMusicRequest(message: string, authorUsername: string, authorRole?: string): Promise<void> {
    const query = MusicService.extractMusicQuery(message);
    if (!query || query.trim().length < 2) {
      this.sendBotMessage(`@${authorUsername} 🤔 No entendí qué canción quieres. Probá con: "!music nombre de la canción"`);
      return;
    }

    const admission = this.admitMusic(authorUsername, authorRole, 'canción');
    if (!admission) return;

    const searchingId = await this.sendBotMessageAndAwaitId(
      `@${authorUsername} 🎵 Buscando "${query}"… un momento.`,
    );

    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;

    this.musicService
      .processMusic(query, authorUsername, this.queueFeedback(authorUsername))
      .then(async (result) => {
        // La frase de entrega la redacta el modelo, en paralelo con la pausa
        // de siempre para que no sume espera. Nunca rechaza: si falla
        // devuelve '' y sale el texto fijo de MusicService.
        const song = result.track ? { title: result.track.title, artist: result.track.artist, query } : null;
        const [line] = await Promise.all([
          song && result.media
            ? this.chatService.songDeliveryLine(this.chatSocketService.username ?? 'bot', authorUsername, song)
            : Promise.resolve(''),
          this.utilsService.sleep(responseDelay),
        ]);
        if (searchingId) this.chatSocketService.deleteMessage(searchingId);
        this.sendBotMessage(line && result.media ? `🎵 <@${authorUsername}> ${line} ${result.media}` : result.text);
        if (song) {
          // Que el bot recuerde qué canciones pasó, como un turno más del
          // historial. Fire-and-forget como la ingesta de abajo.
          void this.chatService.rememberSongSent(authorUsername, song, line).catch(() => {});
        }
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
      })
      .finally(admission.release);
  }

  /**
   * Pide lugar en `MusicQuotaService`. Si no hay, avisa y devuelve `null`.
   * Sin el servicio (tests armados a mano) siempre deja pasar.
   */
  private admitMusic(
    authorUsername: string,
    authorRole: string | undefined,
    what: 'canción' | 'video',
  ): Extract<MusicAdmission, { ok: true }> | null {
    if (!this.musicQuota) return { ok: true, release: () => {} };
    const admission = this.musicQuota.admit(authorUsername, authorRole);
    if (admission.ok === true) return admission;

    const rejected = admission as Extract<MusicAdmission, { ok: false }>;
    const text = {
      user_pending: `⏳ Ya tenés ${rejected.limit} pedidos en camino; esperá a que lleguen antes de pedir otra ${what}.`,
      global_pending: `🎧 Hay muchos pedidos en cola ahora mismo; probá de nuevo en un ratito.`,
      hourly: `⏱️ Llegaste al tope de ${rejected.limit} pedidos por hora; probá más tarde.`,
    }[rejected.reason];
    this.sendBotMessage(`@${authorUsername} ${text}`);
    log.info(`🎵 [QUOTA] ${authorUsername} (${authorRole ?? 'sin rol'}) rechazado: ${rejected.reason}`);
    return null;
  }

  /**
   * Avisa en el chat cuando el pedido tiene gente adelante. Sólo se manda el
   * aviso de cola (no el de "descargando"/"subiendo"): con el pipeline por
   * etapas esas fases son cortas, y un mensaje por cada una sería ruido.
   * Es fire-and-forget — el pipeline ignora cualquier error de acá.
   */
  private queueFeedback(authorUsername: string) {
    return (update: MusicProgress): void => {
      if (update.stage !== 'searching' || update.position < 1) return;
      this.sendBotMessage(`@${authorUsername} ${update.text}`);
    };
  }

  // ─── AniList ───────────────────────────────────────────────────────────────

  /**
   * Resuelve el token y manda lo que haya que mandar (la tarjeta, o el aviso
   * de que no se encontró / de error). Devuelve si hubo tarjeta.
   */
  private async handleAniListRequest(
    rawKind: string,
    rawTitle: string,
    authorUsername: string,
  ): Promise<boolean> {
    const { found, messages } = await this.resolveAniListRequest(rawKind, rawTitle, authorUsername);
    await this.sendAniListMessages(messages);
    return found;
  }

  private async sendAniListMessages(messages: string[]): Promise<void> {
    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
    for (let i = 0; i < messages.length; i++) {
      this.sendBotMessage(messages[i]);
      if (i < messages.length - 1) await this.utilsService.sleep(responseDelay);
    }
  }

  /**
   * Hace la búsqueda sin mandar nada: el que llama decide el orden. Así
   * `handleChatResponse` puede esperar el resultado ANTES de publicar la
   * frase de confirmación del modelo — si no, un "¡Es un clásico! 📖" salía
   * igual para una obra que AniList no conoce, y el bot quedaba opinando de
   * algo que después no podía mostrar.
   */
  private async resolveAniListRequest(
    rawKind: string,
    rawTitle: string,
    authorUsername: string,
  ): Promise<{ found: boolean; messages: string[] }> {
    const kind = AniListService.normalizeKind(rawKind);
    const title = (rawTitle ?? '').trim();
    if (!kind || title.length < 1) {
      return {
        found: false,
        messages: [
          `@${authorUsername} 🤔 No entendí qué buscar en AniList (kind="${rawKind}", title="${rawTitle}").`,
        ],
      };
    }

    try {
      // El caché evita el POST a AniList y, si la sinopsis ya se tradujo, una
      // llamada al modelo de varios cientos de tokens.
      const cached = await this.graphCacheService.findWork(kind, title).catch(() => null);

      // Un acierto "completo" (ficha + traducción) es el único caso que se
      // sirve sin tocar AniList. `findWork` siempre reconstruye la ficha con
      // `description: null` (el caché no persiste el inglés crudo, sólo la
      // traducción) — así que un acierto SIN traducción guardada no puede
      // traducir nada por su cuenta: se trata como "miss parcial" y se va a
      // AniList igual, sólo que conservando la arista `asked_about` como
      // cualquier acierto (ver `refreshCache` más abajo).
      const isFullHit = !!cached && !!cached.sinopsisEs;

      const result = isFullHit ? cached!.result : await this.aniListService.search(kind, title);
      if (!result) {
        return {
          found: false,
          messages: [`@${authorUsername} 🔎 No encontré "${title}" en AniList. Probá con otro título.`],
        };
      }

      // Fire-and-forget: la ingesta es best-effort y no debe ni demorar el
      // armado de la tarjeta ni poder disparar el catch de abajo (que le
      // habla al usuario) si el grafo falla. Se hace SIEMPRE, incluso con
      // acierto de caché: es un upsert idempotente cuyo efecto valioso es la
      // arista `asked_about`, que registra que este usuario preguntó por esta
      // obra — sin eso el grafo perdería señal de interés justo para las
      // obras más populares, que son las que más aciertan en el caché.
      //
      // `refreshCache: !isFullHit` es la mitad de la corrección del TTL
      // invertido: `cachedAt` sólo se renueva cuando esta llamada realmente
      // habló con AniList (miss total, o el miss parcial de arriba). Un
      // acierto completo no aporta ningún dato nuevo, así que no debe
      // renovar la fecha — si lo hiciera, una obra `RELEASING` preguntada
      // seguido quedaría congelada para siempre en el primer estado que vio.
      void this.graphIngestService
        .ingestAniList(authorUsername, result, title, { refreshCache: !isFullHit })
        .catch(() => {});

      let translatedDescription: string | null;

      if (isFullHit) {
        // Ya se tradujo antes: nos ahorramos la llamada al modelo y dejamos
        // registro del ahorro para poder medir la tasa de acierto real.
        translatedDescription = cached!.sinopsisEs;
        void this.usageService
          .record({
            kind: 'translate',
            user: authorUsername,
            promptTokens: 0,
            completionTokens: 0,
            cacheHit: true,
          })
          .catch(() => {});
      } else {
        // AniList sólo expone sinopsis en inglés; traducimos con el mismo modelo
        // OpenAI que ya usa el bot. Si la traducción falla o el modelo no
        // responde, translateToSpanish cae al texto original en inglés para no
        // romper la tarjeta.
        translatedDescription = result.description
          ? await this.chatService.translateToSpanish(result.description, authorUsername)
          : null;

        // La traducción cuesta una llamada al modelo por ficha. Persistirla en
        // el nodo hace que la próxima consulta de esta obra no la pague — pero
        // sólo si de verdad se tradujo: cuando `translateToSpanish` cae a su
        // fallback (timeout, rate-limit, respuesta vacía) devuelve el mismo
        // texto en inglés que recibió, y guardar ESO sería persistir un fallo
        // transitorio como si fuera una traducción buena. Como una obra
        // `FINISHED` no vence nunca, ese inglés quedaría servido para siempre.
        if (translatedDescription && translatedDescription !== result.description) {
          void this.graphCacheService.saveTranslation(result.id, translatedDescription).catch(() => {});
        }
      }

      const localized: AniListResult = { ...result, description: translatedDescription };

      return { found: true, messages: this.formatAniListCard(localized) };
    } catch (err) {
      const code = (err as Error)?.message ?? '';
      const text =
        code === 'RATE_LIMIT'
          ? `@${authorUsername} ⏱️ AniList me está limitando. Probá en un minuto.`
          : code === 'TIMEOUT'
            ? `@${authorUsername} ⌛ AniList está tardando demasiado. Probá de nuevo en un rato.`
          : code === 'NETWORK'
            ? `@${authorUsername} 📡 No pude alcanzar AniList. Intentalo de nuevo en un rato.`
            : `@${authorUsername} 😕 AniList no respondió bien esta vez.`;
      return { found: false, messages: [text] };
    }
  }

  /**
   * Tope por mensaje de la tarjeta. El backend DESCARTA en silencio cualquier
   * mensaje del bot más largo que `maxBotMessageLength` (2000 por default),
   * así que una sinopsis completa larga no se puede mandar de una: se parte
   * en mensajes de continuación. El margen cubre el prefijo de color
   * (`^#rrggbb `) que agrega `sendBotMessage`.
   */
  private static readonly ANILIST_CARD_MAX_LENGTH = 1800;

  /**
   * Arma la tarjeta como una lista de mensajes: casi siempre uno solo, y más
   * cuando la sinopsis completa no entra. La sinopsis ya NO se recorta — antes
   * se cortaba a 320 caracteres y se leía siempre a medias.
   */
  private formatAniListCard(r: AniListResult): string[] {
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

    const synopsis = (r.description ?? '').replace(/\s+\n/g, '\n').trim();

    const head = [cover, `**${title}**`, facts.join(' · '), counts.join(' · '), genres]
      .filter((p) => p && p.length > 0)
      .join('\n');
    const link = `🔗 ${r.url}`;
    const max = BotService.ANILIST_CARD_MAX_LENGTH;

    const whole = [head, synopsis, link].filter((p) => p.length > 0).join('\n');
    if (whole.length <= max) return [whole];

    // El primer trozo comparte mensaje con la cabecera; los siguientes van
    // solos. El link cierra el último trozo si entra, si no va aparte.
    const chunks = this.chunkText(synopsis, max - head.length - 1, max);
    const messages = [chunks[0] ? `${head}\n${chunks[0]}` : head, ...chunks.slice(1)];
    const last = messages.length - 1;
    if (messages[last].length + 1 + link.length <= max) messages[last] += `\n${link}`;
    else messages.push(link);
    return messages;
  }

  /**
   * Parte un texto en trozos sin cortar palabras: prefiere un salto de línea,
   * después un espacio. `firstBudget` es el lugar que deja la cabecera en el
   * primer mensaje (puede ser 0: entonces el primer trozo queda vacío y la
   * sinopsis arranca en el mensaje siguiente).
   */
  private chunkText(text: string, firstBudget: number, budget: number): string[] {
    const chunks: string[] = [];
    let rest = text;
    let limit = Math.max(firstBudget, 0);
    while (rest.length > limit) {
      if (limit === 0) {
        chunks.push('');
        limit = budget;
        continue;
      }
      const window = rest.slice(0, limit + 1);
      let cut = window.lastIndexOf('\n');
      if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
      if (cut < limit * 0.5) cut = limit;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
      limit = budget;
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  // ─── Video ─────────────────────────────────────────────────────────────────

  private async handleVideoRequest(message: string, authorUsername: string, authorRole?: string): Promise<void> {
    const query = MusicService.extractVideoQuery(message);
    if (!query || query.trim().length < 2) {
      this.sendBotMessage(`@${authorUsername} 🤔 No entendí qué video quieres. Probá con: "!video nombre del video"`);
      return;
    }

    const admission = this.admitMusic(authorUsername, authorRole, 'video');
    if (!admission) return;

    const searchingId = await this.sendBotMessageAndAwaitId(
      `@${authorUsername} 🎬 Buscando video "${query}"… un momento.`,
    );

    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
    // Sin el servicio (tests armados a mano) se respeta el default: embeber.
    const embed = (this.videoSettings?.getMode() ?? 'youtube') === 'youtube';

    this.musicService
      .processVideo(query, authorUsername, this.queueFeedback(authorUsername), { embed })
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
      })
      .finally(admission.release);
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

  private async handleChatResponse(response: string, authorUsername: string, authorRole?: string): Promise<void> {
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
        await this.handleMusicRequest(`!music ${query}`, authorUsername, authorRole);
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
      // Primero se busca, después se habla: la frase de confirmación del
      // modelo ("¡Es un clásico!") sólo tiene sentido si hay al menos una
      // tarjeta que mostrar. Si AniList no encontró nada, sale únicamente el
      // aviso de "no encontré" y no una opinión sobre algo inexistente.
      const results: Array<{ found: boolean; messages: string[] }> = [];
      for (const token of anilistTokens) {
        results.push(await this.resolveAniListRequest(token[1], token[2], authorUsername));
      }
      if (confirmText && results.some((r) => r.found)) {
        this.sendBotMessage(`<@${authorUsername}> ${confirmText}`);
        await this.utilsService.sleep(responseDelay);
      }
      for (const result of results) {
        await this.sendAniListMessages(result.messages);
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

    const parts = this.splitForChat(response, `<@${authorUsername}> `.length);
    for (let i = 0; i < parts.length; i++) {
      const text = i === 0 ? `<@${authorUsername}> ${parts[i]}` : parts[i];
      this.sendBotMessage(text);
      if (i < parts.length - 1) await this.utilsService.sleep(responseDelay);
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  /**
   * "las últimas 2 horas", "última hora", "media hora", "30 min", "hoy" →
   * desde cuándo resumir. Hoy = desde la medianoche de El Salvador. Tope 24 h.
   */
  static parseSummaryPeriod(text: string, now = new Date()): { since: Date; label: string } | null {
    const t = (text ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/\b(de\s+)?hoy\b/.test(t)) {
      const sv = new Date(now.getTime() - 6 * 3_600_000);
      const midnight = Date.UTC(sv.getUTCFullYear(), sv.getUTCMonth(), sv.getUTCDate()) + 6 * 3_600_000;
      return { since: new Date(midnight), label: 'lo que va de hoy' };
    }
    if (/\bultima\s+hora\b/.test(t)) return { since: new Date(now.getTime() - 3_600_000), label: 'la última hora' };
    if (/\bmedia\s+hora\b/.test(t)) return { since: new Date(now.getTime() - 30 * 60_000), label: 'la última media hora' };
    const m = /\b(\d{1,4})\s*(h|hs|horas?|m|min|mins|minutos?)\b/.exec(t);
    if (!m) return null;
    const n = Number(m[1]);
    const hours = m[2].startsWith('h');
    const ms = n * (hours ? 3_600_000 : 60_000);
    if (ms < 60_000 || ms > 24 * 3_600_000) return null;
    const label = hours ? (n === 1 ? 'la última hora' : `las últimas ${n} horas`) : `los últimos ${n} minutos`;
    return { since: new Date(now.getTime() - ms), label };
  }

  /**
   * `!resumen` (desde el anterior) / `!resumen 2h` / `!resumen hoy`, y "bot
   * resumen de las últimas 2 horas" en lenguaje natural (con período).
   * Devuelve true si atendió el mensaje.
   */
  private async tryPeriodSummary(content: string, authorUsername: string, addressesBot: boolean): Promise<boolean> {
    const cmd = /^\s*!resumen\b\s*(.*)$/i.exec(content);
    if (cmd) {
      const arg = cmd[1].trim();
      const period = arg ? BotService.parseSummaryPeriod(arg) : null;
      if (arg && !period) {
        this.sendBotMessage(`@${authorUsername} Uso: !resumen · !resumen 2h · !resumen 30m · !resumen hoy (hasta 24 h)`);
        return true;
      }
      await this.handleSummaryRequest('', authorUsername, period ?? undefined);
      return true;
    }
    if (!addressesBot || !/\b(resumen|resume|resumeme|recap)\b/i.test(content)) return false;
    const period = BotService.parseSummaryPeriod(content);
    if (!period) return false;
    await this.handleSummaryRequest('', authorUsername, period);
    return true;
  }

  private async handleSummaryRequest(
    response: string,
    authorUsername: string,
    period?: { since: Date; label: string },
  ): Promise<void> {
    // Los de período tienen su propio cooldown y NO mueven la marca del
    // resumen normal ("desde el anterior").
    const eventName = period ? 'ResumenPeriodo' : 'Resumen';
    const lastResumenEvent = await this.loggingService.getLastEventType(eventName);
    if (lastResumenEvent.minutesLeft < 10) {
      this.sendBotMessage(`@${authorUsername} Puedes leer el resumen anterior y esperar 10 minutos para generar uno nuevo. 🙂`);
      return;
    }

    const confirmationMessage = response.replace('{{resumen}}', '').trim();
    if (confirmationMessage) {
      this.sendBotMessage(`@${authorUsername} ${confirmationMessage}`);
    }

    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
    await this.utilsService.sleep(responseDelay);

    try {
      log.info('📋 Generando resumen del chat...');
      const resumen = await this.chatService.generateSummary(
        authorUsername,
        this.chatSocketService.username ?? undefined,
        period,
      );

      // Ingesta en lote de los hechos que el modelo extrajo del resumen
      // (Task 5, fase 4b) — captura lo que se habla en el chat sin mencionar
      // al bot, sin ninguna llamada nueva al modelo. Fire-and-forget: no
      // puede demorar ni impedir el envío del resumen si la ingesta falla.
      // `source: 'batch'` la distingue de un SAVE_FACT en vivo (source:
      // 'fact'); la validación de relación/objeto la hace `ingestFact`.
      for (const fact of resumen.facts) {
        void this.graphIngestService
          .ingestFact(fact.user, fact.relation, fact.object, 'batch')
          .catch(() => {});
      }

      // El resumen lo cuenta el modelo con su voz: sin encabezado ni cierre
      // fijos ("📋✨ RESUMEN DEL CHAT", "¡Eso es todo por ahora!"), sólo un
      // 📋 al principio para que se distinga en el chat.
      const resumenParts = this.splitForChat(resumen.text, BotService.SUMMARY_FRAME_CHARS);
      log.info(`📋 Enviando resumen en ${resumenParts.length} parte(s)`);

      for (let i = 0; i < resumenParts.length; i++) {
        const part = resumenParts[i].trim();
        if (!part) continue;
        this.sendBotMessage(i === 0 ? `📋 ${period ? `(${period.label}) ` : ''}${part}` : part);
        if (i < resumenParts.length - 1) await this.utilsService.sleep(responseDelay);
      }

      // Revisión final (Minor #6): `generateSummary` no LANZA cuando el
      // parseo del modelo falla — devuelve normalmente `resumen.text` igual
      // al mensaje de error (`ChatService.SUMMARY_PARSE_ERROR`), que el
      // bucle de arriba ya mandó al chat como si fuera un resumen. Sin esta
      // guarda, ese envío igual quemaba el cooldown de 10 minutos Y borraba
      // los 50 mensajes del log — quien pidió el resumen quedaba sin poder
      // reintentar por un fallo que no fue suyo. Sólo se consume el estado
      // cuando de verdad se generó y envió un resumen.
      if (resumen.text === ChatService.SUMMARY_PARSE_ERROR) {
        log.info('⚠️ El resumen falló al parsear: no se consume el cooldown ni se limpia el log de mensajes.');
      } else {
        // El evento marca hasta dónde se resumió: el próximo resumen arranca
        // desde acá. El log NO se vacía (el bot lo usa como contexto de sala).
        await this.loggingService.saveEventsLog(eventName, authorUsername);
        log.info('✅ Resumen completado');
      }
    } catch (error) {
      log.error('❌ Error generating summary:', error);
      this.sendBotMessage('❌ Error al generar el resumen. Inténtalo más tarde.');
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Ver `BotOutputService.sendBotMessage`. */
  private sendBotMessage(text: string): void {
    this.output.sendBotMessage(text);
  }

  /** Ver `BotOutputService.sendBotMessageAndAwaitId`. */
  private sendBotMessageAndAwaitId(text: string): Promise<string | null> {
    return this.output.sendBotMessageAndAwaitId(text);
  }

  /** Lugar reservado para el "📋 " del principio del resumen. */
  private static readonly SUMMARY_FRAME_CHARS = 8;

  /** Ver `BotOutputService.splitForChat`. */
  private splitForChat(text: string, overhead: number): string[] {
    return this.output.splitForChat(text, overhead);
  }


  // ─── Entrega de recados (Task 5, contexto cruzado) ─────────────────────────

  /**
   * Entrega UN recado pendiente para quien acaba de escribir. Devuelve true
   * si entregó algo.
   *
   * Revisión de código (Important #1): este valor de retorno YA NO decide si
   * el dispatcher corta — antes lo hacía (`if (await
   * this.deliverPendingErrand(...)) return;` en el llamador), bajo el
   * supuesto de que "el mensaje que disparó la entrega no era para el bot".
   * Ese supuesto es falso: este método corre ANTES del filtro de mención, así
   * que en el momento en que se llama todavía no se sabe si el mensaje
   * también interpelaba al bot. Con el supuesto viejo, un `content: 'bot
   * como va'` con un recado pendiente entregaba el recado y CORTABA — la
   * pregunta real desaparecía en silencio, sin que `chatService.chat` llegara
   * a llamarse. Ahora el llamador entrega siempre (efecto secundario
   * incondicional) y deja que el filtro de mención de siempre decida si además
   * corresponde cortar.
   *
   * NO pasa por `rateLimitService.check`: el destinatario no pidió nada, y
   * dejarlo sin cupo por recados ajenos lo dejaría sin poder hablarle al bot.
   * Del lado del destinatario el gasto real está acotado por
   * `MAX_PENDING_PER_TARGET` (recados de hasta 5 autores distintos, sin rate
   * limit) — `MAX_PENDING_PER_AUTHOR` acota cuántos recados puede DEJAR un
   * mismo autor, no cuántos puede RECIBIR una persona de varios autores
   * distintos; el autor sí gastó su propio cupo al dejar cada recado.
   */
  private async deliverPendingErrand(
    authorUsername: string,
    botUsername: string,
  ): Promise<boolean> {
    // Los recados ya no dependen de CROSS_USER_CONTEXT: se crean con la
    // memoria activa y se entregan siempre que haya uno pendiente.
    const errand = await this.errandService.claimNext(authorUsername).catch(() => null);
    if (!errand) return false;

    // Un recado puede traer un sticker (`[sticker: nombre]`, como lo ve el
    // modelo): se saca del texto y se manda en el mismo mensaje. Si no se
    // reconoce, el texto queda como estaba.
    const { text: errandText, sticker } = this.takeErrandSticker(errand.text);

    const drafted = errandText
      ? await this.chatService
          .deliverErrand(botUsername, authorUsername, errand.fromLabel, errandText, errand.secret)
          .catch(() => '')
      : '';

    // El recado ya está marcado como entregado (ver `claimNext`), así que si
    // el modelo falló no hay segunda oportunidad: se manda el texto fijo.
    //
    // Re-revisión (2.1): el texto pasa por `stripIntentTokens` ANTES de
    // `handleChatResponse`. Si la limpieza no deja nada (el modelo redactó
    // sólo un token), cae al mismo texto fijo que ya cubría el fallo del
    // modelo — nunca se publica una mención pelada.
    const fallback = errandText
      ? (errand.secret ? errandText : `${errand.fromLabel} te dejó dicho: ${errandText}`)
      : (errand.secret ? '' : `${errand.fromLabel} te manda esto:`);
    const text = BotService.stripIntentTokens(drafted) || BotService.stripIntentTokens(fallback);
    const message = sticker ? `${text} :${sticker.code}:`.trim() : text;

    // Revisión final de rama (CRITICAL, tercera parte): la entrega sale por
    // `handleChatResponse` y no por `sendBotMessage` directo. El camino
    // directo salteaba TODO lo que ese método hace por cualquier otra cosa
    // que diga el bot: el partido en varias partes por `maxLengthResponse`
    // (un recado de 200 caracteres redactado por el modelo se pasa del tope
    // del chat) y la limpieza de los tokens de intención
    // ({{music:…}}/{{resumen}}/{{usuarios_online}}), que en la rama de
    // fallback se publicaban CRUDOS con la identidad del bot porque el texto
    // del recado nunca se sanitizaba. Lo segundo ya no puede pasar (ahora
    // `ErrandService.create` sanitiza), pero la rama del modelo sigue siendo
    // texto sin filtrar y no hay motivo para que la entrega sea la única voz
    // del bot que no pasa por el mismo embudo. El prefijo de mención lo pone
    // `handleChatResponse` (`<@usuario>`), por eso `message` ya no lo trae.
    await this.handleChatResponse(message, authorUsername);
    this.logOwnMessage(botUsername, sticker ? `${text} [sticker: ${sticker.name}]` : text, authorUsername);
    return true;
  }

  /**
   * Comentario espontáneo como uno más del chat (ver `ProactiveService`).
   * Orden de los filtros: primero los gratis (probabilidad, pausa, largo),
   * después Mongo (¿charla viva?), y recién ahí el modelo, que igual puede
   * pasar. Sale sin mención y queda en el log como cualquier respuesta.
   */
  private async maybeChimeIn(content: string, botUsername: string): Promise<void> {
    if (!this.proactive?.shouldTry(content)) return;
    const rows = await this.loggingService.getRecent(20, 15).catch(() => []);
    if (!ProactiveService.isLively(rows, botUsername)) return;
    this.proactive.markAttempt();
    const text = await this.chatService.chatProactive(botUsername, rows).catch(() => '');
    if (!text) {
      log.info('🤐 Comentario espontáneo: el modelo pasó');
      return;
    }
    for (const part of this.splitForChat(text, 0)) {
      if (part.trim()) this.sendBotMessage(part.trim());
    }
    log.info(`🗣️ Comentario espontáneo: ${text}`);
    this.logOwnMessage(botUsername, text);
  }

  /**
   * Guarda en el log de la sala lo que dijo el bot, para que el contexto de
   * sala y el resumen vean sus respuestas (antes sólo veían a la gente:
   * "lyna: bot qué opinás de X" sin lo que el bot le contestó). Sólo texto
   * de charla: sin tokens `{{…}}`, sin tarjetas de AniList ni el resumen.
   * Fire-and-forget: un fallo de Mongo no puede afectar la respuesta.
   */
  private logOwnMessage(botUsername: string, text: string, toUser?: string): void {
    const clean = bbcodeToPlain(BotService.stripIntentTokens(text ?? ''), 'hide').trim();
    if (!clean || !botUsername) return;
    const line = toUser ? `@${toUser} ${clean}` : clean;
    void Promise.resolve(this.loggingService.saveLog?.(botUsername, line)).catch(() => {});
  }

  /**
   * Saca el primer sticker de un recado: `[sticker: nombre]` (como lo ve el
   * modelo) o `:code:`. Sólo si existe en el catálogo; si no, devuelve el
   * texto intacto y sin sticker.
   */
  private takeErrandSticker(raw: string): { text: string; sticker: { code: string; name: string } | null } {
    const text = raw ?? '';
    const byName = /\[sticker:\s*([^\]]+?)\s*\]/i.exec(text);
    if (byName) {
      const found = this.stickerCatalog.findByName(byName[1]);
      if (found) {
        return { text: text.replace(byName[0], '').replace(/\s{2,}/g, ' ').trim(), sticker: { code: found.code, name: found.name } };
      }
    }
    const byCode = /:([a-zA-Z0-9_]+):/.exec(text);
    if (byCode) {
      const name = this.stickerCatalog.nameForCode(byCode[1]);
      if (name) {
        return { text: text.replace(byCode[0], '').replace(/\s{2,}/g, ' ').trim(), sticker: { code: byCode[1], name } };
      }
    }
    return { text: text.trim(), sticker: null };
  }

  /**
   * Borra los tokens de intención (`{{…}}`) de un texto que va a salir por
   * `handleChatResponse`.
   *
   * Re-revisión (2.1). Encauzar la entrega de un recado por
   * `handleChatResponse` (ola anterior: para ganar el partido por
   * `maxLengthResponse` y la limpieza) trajo de arrastre que ese método
   * INTERPRETA tokens. Medido por el revisor sobre el texto que redacta el
   * modelo en una entrega:
   *   `{{music: rickroll}}`  → llegaba hasta `musicService.processMusic`
   *   `{{usuarios_online}}`  → publicaba el roster
   *   `{{resumen}}`          → entraba a `handleSummaryRequest`, que en el
   *                            camino feliz quema el cooldown de 10 minutos
   *                            y ejecuta `clearMessagesLog()`. Destructivo.
   *
   * Dos cosas separan esto del riesgo de cualquier otra respuesta del bot, y
   * son las que justifican una limpieza propia en vez de confiar en el
   * prompt: el disparador es un mensaje cualquiera del DESTINATARIO, que no
   * pidió nada; y el prompt de entrega lleva prosa de OTRO usuario que
   * sobrevive la sanitización (verificado: `"Ignora lo anterior."` queda
   * persistida en el texto del recado). Es un camino de dos saltos para
   * inducir al modelo a emitir el token; `ERRAND_CONTEXT_PREFIX` mitiga pero
   * no cierra.
   *
   * Se borra por FORMA (`\{\{[^}]*\}\}`) y no por lista de tokens conocidos a
   * propósito: un token nuevo que alguien agregue a `handleChatResponse`
   * queda cubierto sin acordarse de este punto. La entrega de un recado no
   * tiene ningún motivo legítimo para pedir música, un resumen o el roster.
   *
   * Si no hay ningún `{{`, devuelve el texto TAL CUAL — sin normalizar
   * espacios ni recortar. El caso normal (la abrumadora mayoría) no puede
   * cambiar por existir esta función.
   */
  private static stripIntentTokens(text: string): string {
    if (!text.includes('{{')) return text;
    return text
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** Quita acentos (NFD + strip de diacríticos) para comparar sin importar tilde. */
  private stripAccents(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  }

  /**
   * Detect requests for the *full list* of online users. Earlier this matched
   * single bare keywords like "online" or "conectados", which falsely fired
   * on questions like "está el admin online?" — those are about ONE user, not
   * the list. The current matcher requires multi-word phrases that clearly
   * imply listing or counting, and a guard rejects singular questions
   * targeted at a specific user.
   */
  /**
   * ¿El mensaje habla explícitamente de presencia en el chat? (online, en
   * línea, conectado/s, "en el chat", "por aquí"). Es lo que separa "¿cuántos
   * hay conectados?" de "¿cuántas personas fueron?".
   */
  static mentionsChatPresence(message: string): boolean {
    const lower = (message ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    return /(^|[^a-z])(online|en\s+linea|conectad[oa]s?|en\s+(el\s+)?chat|por\s+aqui|aqui)([^a-z]|$)/.test(lower) ||
      /\b(who('?s|\s+is)\s+online|users\s+online|online\s+users)\b/.test(lower);
  }

  private isOnlineUsersRequest(message: string): boolean {
    if (!message || typeof message !== 'string') return false;
    const lower = this.stripAccents(message.toLowerCase()); // strip accents so linea/línea both match

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

