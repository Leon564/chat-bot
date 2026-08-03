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
import { GraphCacheService } from '../graph/graph-cache.service';
import { GraphService, Candidate, MAX_CANDIDATES, MIN_CANDIDATES } from '../graph/graph.service';
import {
  GraphUserService,
  UserFact,
  MIN_FORGET_TERM_LENGTH,
  MAX_FACTS_SHOWN,
} from '../graph/graph-user.service';
import { EdgeType } from '../../common/schemas/graph-edge.schema';
import { UsageService } from '../chat/usage.service';
import { RateLimitService } from './rate-limit.service';
import { CrossContextSettingsService } from '../../common/settings/cross-context-settings.service';

/**
 * Mensaje fijo cuando `RateLimitService.check` rechaza a alguien. Corto y
 * estático a propósito: no llama al modelo para generarlo (eso sería pagar
 * tokens justo para avisar que no hay más tokens para esa persona).
 */
const RATE_LIMITED_MESSAGE = '⏳ Estás mandando mensajes muy seguido. Esperá un poco antes de volver a escribirme.';

/**
 * Etiquetas legibles en segunda persona para cada tipo de arista que puede
 * devolver `GraphUserService.describe`, usadas por `!quesabes`. `has_genre` y
 * `by_artist` casi nunca cuelgan de un nodo `user` (nacen de `work`/`track`,
 * ver `graph-ingest.service.ts`), pero se traducen igual para que el mensaje
 * nunca muestre un `EdgeType` crudo si el grafo llegara a tener una arista
 * así.
 */
const RELATION_LABELS: Record<EdgeType, string> = {
  likes: 'Te gusta',
  dislikes: 'No te gusta',
  asked_about: 'Preguntaste por',
  recommended_to: 'Te recomendé',
  requested: 'Pediste',
  interacts_with: 'Hablás seguido con',
  has_genre: 'Género',
  by_artist: 'Artista',
};

/** Orden fijo de las secciones del mensaje de `!quesabes`, independiente del orden por peso en que llegan los hechos. */
const RELATION_ORDER: EdgeType[] = [
  'likes',
  'dislikes',
  'asked_about',
  'recommended_to',
  'requested',
  'interacts_with',
  'has_genre',
  'by_artist',
];

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
    private readonly graphCacheService: GraphCacheService,
    private readonly graphService: GraphService,
    private readonly graphUserService: GraphUserService,
    private readonly usageService: UsageService,
    private readonly rateLimitService: RateLimitService,
    private readonly crossContextSettings: CrossContextSettingsService,
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

    // Interruptor de emergencia del contexto cruzado. Mismo motivo que
    // !personality para ir antes del filtro de menciones.
    if (await this.handleCrossContextCommand(content, authorUsername, authorRole)) return;

    // "¿qué sabés de mí?": lee el grafo y responde sin mencionar al bot.
    // También va antes del filtro de menciones, mismo motivo que arriba.
    if (await this.handleMemoryCommand(content, authorUsername)) return;

    // "olvidate de X"/"olvidate de todo": borra del grafo. Mismo motivo que
    // arriba para ir antes del filtro de menciones — y por ser la más
    // delicada de las tres (borra datos), no debe depender de que el
    // dispatcher la deje pasar por casualidad.
    if (await this.handleForgetCommand(content, authorUsername)) return;

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

    const response = await this.chatService.chat(content, botUsername, authorUsername);
    if (!response) return;

    await this.handleChatResponse(response, authorUsername);

    // Fire-and-forget, con su propio catch, como el resto de la ingesta al
    // grafo: marca qué candidatas de la recomendación colaborativa (Task 3,
    // fase 5b) terminaron de verdad mencionadas en la respuesta del modelo.
    // SÓLO se marcan esas — marcar de más significa no volver a ofrecer algo
    // bueno; marcar de menos significa repetirse.
    void this.markCollaborativeRecommendations(authorUsername, response).catch(() => {});
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
        this.sendBotMessage(
          `@${authorUsername} 🔎 No encontré "${title}" en AniList. Probá con otro título.`,
        );
        return;
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

      const resumenParts = this.utilsService.splitMessageIntoParts(resumen.text, maxLength);
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

      // Revisión final (Minor #6): `generateSummary` no LANZA cuando el
      // parseo del modelo falla — devuelve normalmente `resumen.text` igual
      // al mensaje de error (`ChatService.SUMMARY_PARSE_ERROR`), que el
      // bucle de arriba ya mandó al chat como si fuera un resumen. Sin esta
      // guarda, ese envío igual quemaba el cooldown de 10 minutos Y borraba
      // los 50 mensajes del log — quien pidió el resumen quedaba sin poder
      // reintentar por un fallo que no fue suyo. Sólo se consume el estado
      // cuando de verdad se generó y envió un resumen.
      if (resumen.text === ChatService.SUMMARY_PARSE_ERROR) {
        console.log('⚠️ El resumen falló al parsear: no se consume el cooldown ni se limpia el log de mensajes.');
      } else {
        await this.loggingService.saveEventsLog('Resumen', authorUsername);
        const clearedCount = await this.loggingService.clearMessagesLog();
        console.log(`✅ Resumen completado y log limpiado (${clearedCount} mensajes eliminados)`);
      }
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

  // ─── Cross-context command (admins) ──────────────────────────────────────

  /**
   * `!contextocruzado on|off|reset|status`. Calcado de
   * `handlePersonalityCommand`: por regex y sin gastar una llamada al modelo,
   * y va antes del filtro de menciones para que un admin no tenga que
   * nombrar al bot para apagar la feature. Ese detalle importa acá más que en
   * personalidad — es el interruptor de emergencia.
   */
  private async handleCrossContextCommand(
    content: string,
    authorUsername: string,
    authorRole?: string,
  ): Promise<boolean> {
    const match = content.trim().match(/^!(?:contextocruzado|crosscontext)(?:\s+(\w+))?\s*$/i);
    if (!match) return false;

    const sub = (match[1] ?? 'status').toLowerCase();

    if (authorRole !== 'admin' && authorRole !== 'superAdmin') {
      this.sendBotMessage(`@${authorUsername} ❌ Solo admins pueden cambiar el contexto cruzado.`);
      return true;
    }

    if (sub === 'on' || sub === 'off') {
      this.crossContextSettings.setOverride(sub === 'on');
      this.sendBotMessage(
        `@${authorUsername} ✅ Contexto cruzado ${sub === 'on' ? 'activado' : 'desactivado'}.`,
      );
      console.log(`🔗 [CROSS-CONTEXT] ${authorUsername} → ${sub}`);
      return true;
    }

    if (sub === 'reset' || sub === 'env') {
      this.crossContextSettings.setOverride(null);
      const info = this.crossContextSettings.getInfo();
      this.sendBotMessage(
        `@${authorUsername} ↩️ Contexto cruzado reseteado al valor del .env: ${info.enabled ? 'activado' : 'desactivado'}.`,
      );
      return true;
    }

    if (sub === 'status') {
      const info = this.crossContextSettings.getInfo();
      const note = info.source === 'override' ? ' (override en runtime)' : ' (del .env)';
      this.sendBotMessage(
        `@${authorUsername} 🔗 Contexto cruzado: ${info.enabled ? 'activado' : 'desactivado'}${note}.`,
      );
      return true;
    }

    this.sendBotMessage(`@${authorUsername} Uso: !contextocruzado on | off | reset | status`);
    return true;
  }

  // ─── Memory command (!quesabes) ────────────────────────────────────────────

  /**
   * Recognize and execute the `!quesabes` command: le muestra a quien lo
   * escribe todo lo que el bot tiene guardado sobre esa persona en el grafo
   * de conocimiento. Devuelve `true` cuando el mensaje fue este comando
   * (atendido de cualquier forma) para que el llamador corte el resto del
   * dispatcher — mismo patrón que `handlePersonalityCommand`. Cero llamadas
   * al modelo: se resuelve enteramente contra `GraphUserService.describe`.
   *
   * Privacidad: el comando SIEMPRE describe a quien lo escribe. Cualquier
   * texto después de "!quesabes" (p. ej. "!quesabes Nico") se ignora a
   * propósito — no hay forma de que alguien consulte lo que el bot guarda
   * sobre otra persona.
   */
  private async handleMemoryCommand(content: string, authorUsername: string): Promise<boolean> {
    const match = content.trim().match(/^!quesabes\b/i);
    if (!match) return false;

    const facts = await this.graphUserService.describe(authorUsername);

    if (facts.length === 0) {
      this.sendBotMessage(`@${authorUsername} 🤷 Todavía no tengo nada guardado sobre vos.`);
      return true;
    }

    const message = this.formatMemoryFacts(facts);
    const maxLength = this.configService.get<number>('bot.maxLengthResponse') || 200;
    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
    const parts = this.utilsService.splitMessageIntoParts(message, maxLength);

    // Minor #7: única ruta multiparte del servicio que no respetaba
    // `responseDelay` entre mensajes — con 40 hechos son varias partes de
    // golpe. Mismo patrón que `handleChatResponse`/`handleSummaryRequest`.
    for (let i = 0; i < parts.length; i++) {
      const text = i === 0 ? `@${authorUsername} ${parts[i]}` : parts[i];
      this.sendBotMessage(text);
      if (i < parts.length - 1) await this.utilsService.sleep(responseDelay);
    }
    return true;
  }

  /**
   * Agrupa los hechos del grafo por relación, con una etiqueta legible en
   * segunda persona (`Te gusta:`, `No te gusta:`, …) en vez del `EdgeType`
   * crudo. `RELATION_ORDER` fija el orden de las secciones para que el
   * mensaje sea estable entre llamados, no dependa del orden de llegada de
   * `describe` (que es por peso, no por tipo).
   *
   * Minor #5: `RELATION_ORDER` es un array suelto (a diferencia de
   * `RELATION_LABELS`, tipado `Record<EdgeType, string>`, que rompe la
   * compilación si falta un tipo) — si se agrega un `EdgeType` nuevo y nadie
   * actualiza `RELATION_ORDER`, esa categoría desaparecería del mensaje SIN
   * AVISO. En un comando cuyo contrato es "esto es TODO lo que tengo sobre
   * vos", ocultar una categoría es peor que mostrarla sin traducir. Por eso,
   * después de recorrer `RELATION_ORDER`, cualquier relación agrupada que
   * haya quedado afuera se emite igual (con el `EdgeType` crudo si no hay
   * label) — el default es mostrar de más, nunca ocultar.
   */
  private formatMemoryFacts(facts: UserFact[]): string {
    const grouped = new Map<EdgeType, string[]>();
    for (const fact of facts) {
      const labels = grouped.get(fact.relation) ?? [];
      labels.push(fact.label);
      grouped.set(fact.relation, labels);
    }

    const lines: string[] = [];
    const seen = new Set<EdgeType>();
    for (const relation of RELATION_ORDER) {
      seen.add(relation);
      const labels = grouped.get(relation);
      if (!labels || labels.length === 0) continue;
      lines.push(`${RELATION_LABELS[relation]}: ${labels.join(', ')}`);
    }
    for (const [relation, labels] of grouped) {
      if (seen.has(relation) || labels.length === 0) continue;
      lines.push(`${RELATION_LABELS[relation] ?? relation}: ${labels.join(', ')}`);
    }

    // Minor #6: sin este aviso, alguien con más de `MAX_FACTS_SHOWN` aristas
    // ve una lista que parece completa acá y después, en "!olvida todo", un
    // conteo mayor sin relación aparente con lo que acaba de leer.
    if (facts.length >= MAX_FACTS_SHOWN) {
      lines.push(`\n(te muestro las ${MAX_FACTS_SHOWN} más fuertes)`);
    }

    return `🧠 Esto es lo que tengo guardado sobre vos:\n\n${lines.join('\n')}`;
  }

  // ─── Forget command (!olvida) ──────────────────────────────────────────────

  /**
   * Recognize and execute `!olvida`: borra del grafo lo que el bot tiene
   * guardado sobre quien lo escribe. Devuelve `true` cuando el mensaje fue
   * este comando (atendido de cualquier forma) para que el llamador corte el
   * resto del dispatcher — mismo patrón que `handlePersonalityCommand` y
   * `handleMemoryCommand`. Cero llamadas al modelo.
   *
   * Es la tarea más delicada de las tres: borra datos. El principio no
   * negociable es que sólo se tocan las aristas SALIENTES de quien escribe
   * el comando — nunca nodos, nunca aristas de otra persona, nunca más de lo
   * que se pidió. Toda la resolución real vive en `GraphUserService`
   * (`findForgettable`/`forget`/`forgetAll`); acá sólo se decide QUÉ pedirle
   * y cómo confirmarlo.
   *
   * Privacidad: igual que `!quesabes`, el comando SIEMPRE opera sobre quien
   * lo escribe. No existe (ni debe existir) una forma de que alguien borre
   * lo que el bot sabe de otra persona.
   *
   * Formas soportadas:
   * - `!olvida` (sin término): responde el uso, no borra nada.
   * - `!olvida todo`: NO borra — responde cuántas cosas borraría y pide
   *   `!olvida todo si` para confirmar. Requerir una confirmación explícita
   *   para el borrado total (y sólo para ese caso) es a propósito: es el
   *   único camino que puede vaciar TODO lo guardado sobre una persona de un
   *   solo golpe.
   * - `!olvida todo si`: confirma y borra todo lo saliente.
   * - `!olvida <término>`: borra lo que matchee `término` (por etiqueta o
   *   alias del destino) y confirma cuánto borró. No pide confirmación —el
   *   usuario ya nombró el destino, así que la lista que se muestra es
   *   informativa, no una pregunta. Se rechaza si el término tiene menos de
   *   `MIN_FORGET_TERM_LENGTH` caracteres: es demasiado ambiguo para borrar
   *   a ciegas.
   */
  private async handleForgetCommand(content: string, authorUsername: string): Promise<boolean> {
    const match = content.trim().match(/^!olvida(?:\s+(.+))?$/is);
    if (!match) return false;

    const rawArg = (match[1] ?? '').trim();

    if (!rawArg) {
      this.sendBotMessage(
        `@${authorUsername} Uso: !olvida <término> (p. ej. "!olvida berserk") | !olvida todo`,
      );
      return true;
    }

    const lower = rawArg.toLowerCase();
    // Minor #4: la confirmación se compara sin acentos (mismo criterio que
    // `isOnlineUsersRequest` en este archivo) para que "!olvida todo sí" —la
    // forma natural de confirmar en español— no caiga al buscador de
    // términos y responda "no encontré nada guardado sobre 'todo sí'". Si
    // esto no matchea, el flujo cae más abajo a la rama de término/longitud
    // mínima, que nunca borra nada por su cuenta — el modo de falla sigue
    // siendo "no hace nada", nunca "borra de más".
    const lowerNoAccents = this.stripAccents(lower);

    if (lower === 'todo') {
      const count = await this.graphUserService.countForgettableAll(authorUsername);
      if (count === 0) {
        this.sendBotMessage(`@${authorUsername} 🤷 Ya no tengo nada guardado sobre vos.`);
        return true;
      }
      this.sendBotMessage(
        `@${authorUsername} ⚠️ Esto borraría ${count} cosa${count !== 1 ? 's' : ''} que tengo guardadas sobre vos. Escribí "!olvida todo si" para confirmar.`,
      );
      return true;
    }

    if (/^todo\s+si$/i.test(lowerNoAccents)) {
      const deleted = await this.graphUserService.forgetAll(authorUsername);
      if (deleted === 0) {
        this.sendBotMessage(`@${authorUsername} 🤷 Ya no tenía nada guardado sobre vos.`);
        return true;
      }
      this.sendBotMessage(
        `@${authorUsername} 🗑️ Listo, borré ${deleted} cosa${deleted !== 1 ? 's' : ''} que tenía guardadas sobre vos.`,
      );
      return true;
    }

    if (rawArg.length < MIN_FORGET_TERM_LENGTH) {
      this.sendBotMessage(
        `@${authorUsername} 🤔 "${rawArg}" es muy corto — necesito al menos ${MIN_FORGET_TERM_LENGTH} caracteres para no borrar a ciegas.`,
      );
      return true;
    }

    const matches = await this.graphUserService.findForgettable(authorUsername, rawArg);
    if (matches.length === 0) {
      this.sendBotMessage(`@${authorUsername} 🤷 No encontré nada guardado sobre "${rawArg}" para olvidar.`);
      return true;
    }

    const deleted = await this.graphUserService.forget(authorUsername, rawArg);
    const distinctLabels = Array.from(new Set(matches.map((m) => m.label)));
    const detail = distinctLabels.length > 1 ? `: ${distinctLabels.join(', ')}` : ` sobre "${distinctLabels[0]}"`;
    this.sendBotMessage(
      `@${authorUsername} 🗑️ Borré ${deleted} cosa${deleted !== 1 ? 's' : ''}${detail}.`,
    );
    return true;
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

