import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatService } from '../chat/chat.service';
import { UtilsService } from '../../common/utils/utils.service';
import { ChatSocketService } from '../chat-socket/chat-socket.service';
import { GraphUserService, UserFact, MIN_FORGET_TERM_LENGTH, MAX_FACTS_SHOWN } from '../graph/graph-user.service';
import { EdgeType } from '../../common/schemas/graph-edge.schema';
import { UsageService } from '../chat/usage.service';
import { CrossContextSettingsService } from '../../common/settings/cross-context-settings.service';
import { ErrandService } from '../graph/errand.service';
import {
  RoomInstructionsService,
  INSTRUCTION_STAFF_ROLES,
  MAX_ROOM_INSTRUCTIONS,
} from '../chat/room-instructions.service';
import { BotOutputService } from './bot-output.service';
import { createLog } from '../../common/utils/log';

const log = createLog('BotCommandsService');

/** Ventanas que acepta `!uso`. */
const USAGE_WINDOWS: Record<string, { ms: number; label: string }> = {
  '24h': { ms: 24 * 3_600_000, label: 'últimas 24 h' },
  hoy: { ms: 24 * 3_600_000, label: 'últimas 24 h' },
  '7d': { ms: 7 * 86_400_000, label: 'últimos 7 días' },
  semana: { ms: 7 * 86_400_000, label: 'últimos 7 días' },
  '30d': { ms: 30 * 86_400_000, label: 'últimos 30 días' },
  mes: { ms: 30 * 86_400_000, label: 'últimos 30 días' },
};

/** "45m", "1h 20m", "2d 3h"; "menos de 1m" por debajo del minuto. */
export function formatRemaining(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return 'menos de 1m';
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

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

/**
 * Los comandos `!…` del bot (`!ayuda`, `!uso`, `!instruccion`, `!quesabes`,
 * `!olvida`, recados, y los interruptores de admin). Ninguno llama al modelo.
 * Salió de `BotService` para achicarlo: el dispatcher sólo llama a `handle()`.
 */
@Injectable()
export class BotCommandsService {
  constructor(
    private readonly configService: ConfigService,
    private readonly chatService: ChatService,
    private readonly utilsService: UtilsService,
    private readonly chatSocketService: ChatSocketService,
    private readonly graphUserService: GraphUserService,
    private readonly usageService: UsageService,
    private readonly crossContextSettings: CrossContextSettingsService,
    private readonly errandService: ErrandService,
    private readonly output: BotOutputService,
    @Optional() private readonly roomInstructions?: RoomInstructionsService,
  ) {}

  /**
   * Prueba cada comando en orden y devuelve `true` si el mensaje era uno de
   * ellos (atendido de cualquier forma), para que el dispatcher corte ahí.
   */
  async handle(content: string, authorUsername: string, authorRole?: string): Promise<boolean> {
    return (
      (await this.handlePersonalityCommand(content, authorUsername, authorRole)) ||
      (await this.handleCrossContextCommand(content, authorUsername, authorRole)) ||
      (await this.handleSharedContextCommand(content, authorUsername, authorRole)) ||
      (await this.handleRoomInstructionsCommand(content, authorUsername, authorRole)) ||
      (await this.handleHelpCommand(content, authorUsername, authorRole)) ||
      (await this.handleUsageCommand(content, authorUsername, authorRole)) ||
      (await this.handleMemoryCommand(content, authorUsername)) ||
      (await this.handleForgetCommand(content, authorUsername)) ||
      (await this.handleErrandCommands(content, authorUsername))
    );
  }

  private sendBotMessage(text: string): void {
    this.output.sendBotMessage(text);
  }

  private splitForChat(text: string, overhead: number): string[] {
    return this.output.splitForChat(text, overhead);
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
      log.info(`🎭 [PERSONALITY] ${authorUsername} → ${sub}`);
      return true;
    }

    if (sub === 'reset' || sub === 'env') {
      this.chatService.setPersonalityOverride(null);
      const info = this.chatService.getPersonalityInfo();
      this.sendBotMessage(
        `@${authorUsername} ↩️ Personalidad reseteada al valor del .env: "${info.current}".`,
      );
      log.info(`🎭 [PERSONALITY] ${authorUsername} → reset (.env: ${info.current})`);
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
      log.info(`🔗 [CROSS-CONTEXT] ${authorUsername} → ${sub}`);
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

  // ─── Shared-context command (admins) ─────────────────────────────────────

  /**
   * `!sharedcontext on|off|reset|status`: historial de toda la sala o de
   * cada usuario. Calcado de `handlePersonalityCommand`, y como aquel el
   * override vive en `ChatService`.
   */
  private async handleSharedContextCommand(
    content: string,
    authorUsername: string,
    authorRole?: string,
  ): Promise<boolean> {
    const match = content.trim().match(/^!sharedcontext(?:\s+(\w+))?\s*$/i);
    if (!match) return false;

    const sub = (match[1] ?? 'status').toLowerCase();

    if (authorRole !== 'admin' && authorRole !== 'superAdmin') {
      this.sendBotMessage(`@${authorUsername} ❌ Solo admins pueden cambiar el contexto compartido.`);
      return true;
    }

    if (sub === 'on' || sub === 'off') {
      this.chatService.setSharedContextOverride(sub === 'on');
      this.sendBotMessage(
        `@${authorUsername} ✅ Contexto compartido ${sub === 'on' ? 'activado' : 'desactivado'}.`,
      );
      log.info(`👥 [SHARED-CONTEXT] ${authorUsername} → ${sub}`);
      return true;
    }

    if (sub === 'reset' || sub === 'env') {
      this.chatService.setSharedContextOverride(null);
      const info = this.chatService.getSharedContextInfo();
      this.sendBotMessage(
        `@${authorUsername} ↩️ Contexto compartido reseteado al valor del .env: ${info.enabled ? 'activado' : 'desactivado'}.`,
      );
      log.info(`👥 [SHARED-CONTEXT] ${authorUsername} → reset (.env: ${info.enabled})`);
      return true;
    }

    if (sub === 'status') {
      const info = this.chatService.getSharedContextInfo();
      const note = info.source === 'override' ? ' (override en runtime)' : ' (del .env)';
      this.sendBotMessage(
        `@${authorUsername} 👥 Contexto compartido: ${info.enabled ? 'activado' : 'desactivado'}${note}.`,
      );
      return true;
    }

    this.sendBotMessage(`@${authorUsername} Uso: !sharedcontext on | off | reset | status`);
    return true;
  }

  // ─── Room instructions (!instruccion / !instrucciones) ─────────────────────

  /**
   * Instrucciones permanentes de la sala (ver `RoomInstructionsService`):
   *   !instrucciones                 → lista numerada (mod/admin)
   *   !instruccion <texto>           → agrega una (admin)
   *   !instruccion quitar <n>        → quita la número n (admin)
   *   !instrucciones reset           → borra todas (admin)
   * Los mods también pueden agregarlas hablándole al bot ("de ahora en
   * adelante…", SAVE_INSTRUCTION), por eso pueden ver la lista.
   */
  private async handleRoomInstructionsCommand(
    content: string,
    authorUsername: string,
    authorRole?: string,
  ): Promise<boolean> {
    const match = content.trim().match(/^!instrucci(?:o|ó)n(es)?(?:\s+([\s\S]*))?$/i);
    if (!match) return false;

    const arg = (match[2] ?? '').trim();
    const isAdmin = authorRole === 'admin' || authorRole === 'superAdmin';
    const isStaff = !!authorRole && INSTRUCTION_STAFF_ROLES.has(authorRole);
    const usage =
      'Uso: !instrucciones (ver lista) | !instruccion [30m|2h|1d] <texto> | !instruccion quitar <n> | !instrucciones reset';

    if (!this.roomInstructions) {
      this.sendBotMessage(`@${authorUsername} ❌ Las instrucciones de sala no están disponibles.`);
      return true;
    }

    const lower = arg.toLowerCase();
    const isList = arg === '' || lower === 'lista' || lower === 'list' || lower === 'ver';
    const isReset = /^(reset|resetear|limpiar|borrar\s+todas?|todas?\s+fuera)$/.test(lower);
    const removeMatch = arg.match(/^(?:quitar|borrar|eliminar|del|rm|-)\s*#?(\d+)$/i);

    if (isList) {
      if (!isStaff) {
        this.sendBotMessage(`@${authorUsername} ❌ Solo mods y admins pueden ver las instrucciones.`);
        return true;
      }
      const list = await this.roomInstructions.list();
      if (list.length === 0) {
        this.sendBotMessage(`@${authorUsername} 📭 No hay instrucciones de sala activas.`);
        return true;
      }
      const now = Date.now();
      const lines = list.map((i, n) => {
        const expiry = i.expiresAt ? `, vence en ${formatRemaining(i.expiresAt.getTime() - now)}` : '';
        return `${n + 1}. ${i.text} (de ${i.createdBy}${expiry})`;
      });
      const message = `📌 Instrucciones de sala (${list.length}/${MAX_ROOM_INSTRUCTIONS}):\n${lines.join('\n')}`;
      const parts = this.splitForChat(message, `@${authorUsername} `.length);
      const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
      for (let i = 0; i < parts.length; i++) {
        this.sendBotMessage(i === 0 ? `@${authorUsername} ${parts[i]}` : parts[i]);
        if (i < parts.length - 1) await this.utilsService.sleep(responseDelay);
      }
      return true;
    }

    if (!isAdmin) {
      this.sendBotMessage(`@${authorUsername} ❌ Solo admins pueden cambiar las instrucciones de sala.`);
      return true;
    }

    if (isReset) {
      const count = await this.roomInstructions.clear();
      this.sendBotMessage(
        `@${authorUsername} 🧹 ${count > 0 ? `Borré ${count} instrucción${count === 1 ? '' : 'es'} de sala.` : 'No había instrucciones de sala.'}`,
      );
      log.info(`📌 [ROOM-INSTRUCTIONS] ${authorUsername} → reset (${count})`);
      return true;
    }

    if (removeMatch) {
      const n = Number(removeMatch[1]);
      const removed = await this.roomInstructions.removeAt(n);
      this.sendBotMessage(
        removed
          ? `@${authorUsername} 🗑️ Quité la instrucción ${n}: "${removed.text}"`
          : `@${authorUsername} ❌ No hay instrucción número ${n}. Mirá la lista con !instrucciones`,
      );
      if (removed) log.info(`📌 [ROOM-INSTRUCTIONS] ${authorUsername} → quitar #${n}`);
      return true;
    }

    // "quitar" sin número válido: no guardarlo como instrucción literal.
    if (/^(?:quitar|borrar|eliminar|del|rm)\b/i.test(arg)) {
      this.sendBotMessage(`@${authorUsername} ${usage}`);
      return true;
    }

    // `!instrucciones algo` (plural) que no es lista/reset ni quitar: mejor
    // mostrar el uso que guardar "algo" como instrucción por un typo.
    if (match[1]) {
      this.sendBotMessage(`@${authorUsername} ${usage}`);
      return true;
    }

    // Duración opcional al principio: "!instruccion 2h Respondé con colores".
    const [first, ...rest] = arg.split(/\s+/);
    if (rest.length === 0 && RoomInstructionsService.parseDuration(first)) {
      // "!instruccion 2h" a secas: falta el texto, no guardar "2h".
      this.sendBotMessage(`@${authorUsername} ${usage}`);
      return true;
    }
    const ttlMs = rest.length > 0 ? RoomInstructionsService.parseDuration(first) : null;
    const text = ttlMs ? rest.join(' ') : arg;

    const result = await this.roomInstructions.add(text, authorUsername, 'command', ttlMs);
    if (result.ok) {
      const lasts = ttlMs ? ` durante ${formatRemaining(ttlMs)}` : ' hasta que la quiten';
      this.sendBotMessage(`@${authorUsername} 📌 Instrucción ${result.position} guardada. Va a aplicar a todas mis respuestas${lasts}.`);
      log.info(`📌 [ROOM-INSTRUCTIONS] ${authorUsername} → agregar #${result.position}`);
    } else {
      const reason = {
        empty: 'La instrucción está vacía.',
        duplicate: 'Esa instrucción ya está en la lista.',
        full: `Ya hay ${MAX_ROOM_INSTRUCTIONS} instrucciones; quitá alguna con !instruccion quitar <n>.`,
        error: 'No pude guardarla, probá de nuevo.',
      }[result.reason];
      this.sendBotMessage(`@${authorUsername} ❌ ${reason}`);
    }
    return true;
  }

  // ─── Help (!ayuda) ───────────────────────────────────────────────────────

  /** `!ayuda` / `!help` / `!comandos`: los comandos que puede usar quien pregunta. */
  private async handleHelpCommand(
    content: string,
    authorUsername: string,
    authorRole?: string,
  ): Promise<boolean> {
    if (!/^!(?:ayuda|help|comandos)\s*$/i.test(content.trim())) return false;

    const bot = this.chatSocketService.username ?? 'bot';
    const isStaff = !!authorRole && INSTRUCTION_STAFF_ROLES.has(authorRole);
    const isAdmin = authorRole === 'admin' || authorRole === 'superAdmin';
    const video = !!this.configService.get<boolean>('video.enabled');

    const lines = [
      '📖 Comandos del bot:',
      `• Nombrame (${bot}) o respondé a un mensaje mío para charlar`,
      '• !music <canción> — pido y paso una canción',
      ...(video ? ['• !video <búsqueda> — paso un video'] : []),
      `• "${bot} resumen" — resumen de lo que se habló`,
      '• !quesabes — lo que recuerdo de vos',
      '• !olvida <algo> | !olvida todo — que me olvide de cosas tuyas',
      '• !misrecados — recados que dejaste y todavía no entregué',
      '• !cancelarrecado <n> — cancela uno de tus recados',
      '• !rechazarrecados — borra sin leer los recados que hay para vos',
      '• !ayuda — esta lista',
    ];
    if (isStaff) {
      lines.push('', '🛡️ Staff:', '• !instrucciones — instrucciones de sala activas');
    }
    if (isAdmin) {
      lines.push(
        '',
        '👑 Admin:',
        '• !instruccion [30m|2h|1d] <texto> — instrucción para toda la sala',
        '• !instruccion quitar <n> | !instrucciones reset',
        '• !uso [24h|7d|30d] — consumo del modelo',
        '• !personality default|unfiltered|reset|status',
        '• !sharedcontext on|off|reset|status',
        '• !contextocruzado on|off|reset|status',
      );
    }

    const parts = this.splitForChat(lines.join('\n'), `@${authorUsername} `.length);
    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
    for (let i = 0; i < parts.length; i++) {
      this.sendBotMessage(i === 0 ? `@${authorUsername} ${parts[i]}` : parts[i]);
      if (i < parts.length - 1) await this.utilsService.sleep(responseDelay);
    }
    return true;
  }

  // ─── Recados (!misrecados / !cancelarrecado / !rechazarrecados) ─────────

  /**
   * Hasta ahora un recado no se podía ver ni cancelar: ni el autor (que se
   * arrepentía) ni el destinatario (que lo iba a escuchar en público con la
   * voz del bot la próxima vez que escribiera). Los tres comandos operan
   * SIEMPRE sobre quien escribe, igual que `!quesabes`/`!olvida`; no hay forma
   * de tocar recados de otra persona. `!rechazarrecados` no muestra el texto:
   * la idea es poder sacárselos de encima sin leerlos.
   */
  private async handleErrandCommands(content: string, authorUsername: string): Promise<boolean> {
    const text = content.trim();
    const list = /^!misrecados\s*$/i.test(text);
    const cancel = text.match(/^!cancelarrecado(?:\s+#?(\S+))?\s*$/i);
    const reject = /^!rechazarrecados\s*$/i.test(text);
    if (!list && !cancel && !reject) return false;

    try {
      if (list) {
        const sent = await this.errandService.listSent(authorUsername);
        if (sent.length === 0) {
          this.sendBotMessage(`@${authorUsername} 📭 No tenés recados pendientes.`);
          return true;
        }
        const now = Date.now();
        const lines = sent.map(
          (e, i) =>
            `${i + 1}. ${e.secret ? '🤫 ' : ''}Para ${e.forUser}: "${e.text}" (vence en ${formatRemaining(e.expiresAt.getTime() - now)})`,
        );
        const message = `📨 Tus recados pendientes:\n${lines.join('\n')}\nPara cancelar uno: !cancelarrecado <n>`;
        const parts = this.splitForChat(message, `@${authorUsername} `.length);
        const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
        for (let i = 0; i < parts.length; i++) {
          this.sendBotMessage(i === 0 ? `@${authorUsername} ${parts[i]}` : parts[i]);
          if (i < parts.length - 1) await this.utilsService.sleep(responseDelay);
        }
        return true;
      }

      if (cancel) {
        const n = Number(cancel[1]);
        if (!cancel[1] || !Number.isInteger(n)) {
          this.sendBotMessage(`@${authorUsername} Uso: !cancelarrecado <n> (mirá los números con !misrecados)`);
          return true;
        }
        const result = await this.errandService.cancelSent(authorUsername, n);
        if (result.ok === true) {
          this.sendBotMessage(`@${authorUsername} 🗑️ Cancelé el recado para ${result.errand.forUser}.`);
        } else {
          const reason = (result as { reason: 'not_found' | 'gone' }).reason;
          this.sendBotMessage(
            reason === 'gone'
              ? `@${authorUsername} 📬 Ese recado ya lo entregué, no se puede cancelar.`
              : `@${authorUsername} ❌ No tenés un recado número ${n}. Mirá la lista con !misrecados`,
          );
        }
        return true;
      }

      const removed = await this.errandService.rejectIncoming(authorUsername);
      this.sendBotMessage(
        removed > 0
          ? `@${authorUsername} 🧹 Borré ${removed} recado${removed === 1 ? '' : 's'} que había para vos, sin entregarlos.`
          : `@${authorUsername} 📭 No había recados para vos.`,
      );
      return true;
    } catch (err) {
      log.warn(`📨 [RECADOS] Falló un comando de recados de ${authorUsername}: ${(err as Error)?.message}`);
      this.sendBotMessage(`@${authorUsername} ❌ No pude leer los recados, probá de nuevo.`);
      return true;
    }
  }

  // ─── Usage (!uso) ────────────────────────────────────────────────────────

  /** `!uso [24h|7d|30d]` (admin): llamadas, tokens, costo estimado y quién más usa. */
  private async handleUsageCommand(
    content: string,
    authorUsername: string,
    authorRole?: string,
  ): Promise<boolean> {
    const match = content.trim().match(/^!uso(?:\s+(\S+))?\s*$/i);
    if (!match) return false;

    if (authorRole !== 'admin' && authorRole !== 'superAdmin') {
      this.sendBotMessage(`@${authorUsername} ❌ Solo admins pueden ver el consumo.`);
      return true;
    }

    const key = (match[1] ?? '24h').toLowerCase();
    const window = Object.prototype.hasOwnProperty.call(USAGE_WINDOWS, key) ? USAGE_WINDOWS[key] : null;
    if (!window) {
      this.sendBotMessage(`@${authorUsername} Uso: !uso [24h|7d|30d]`);
      return true;
    }

    const since = new Date(Date.now() - window.ms);
    let summary: Awaited<ReturnType<UsageService['summarize']>>;
    try {
      summary = await this.usageService.summarize(since);
    } catch (err) {
      log.info(`📊 [USO] Falló el resumen de consumo: ${(err as Error)?.message}`);
      this.sendBotMessage(`@${authorUsername} ❌ No pude leer el consumo, probá de nuevo.`);
      return true;
    }

    const fmt = (n: number) => n.toLocaleString('es-ES');
    const priceIn = this.configService.get<number>('bot.llmPriceInputPerM') ?? 0;
    const priceOut = this.configService.get<number>('bot.llmPriceOutputPerM') ?? 0;
    // Sin precio propio para la entrada cacheada, se cobra como entrada normal.
    const priceCached = this.configService.get<number | null>('bot.llmPriceCachedInputPerM') ?? priceIn;
    const cached = Math.min(summary.cachedPromptTokens ?? 0, summary.promptTokens);
    const cost =
      ((summary.promptTokens - cached) * priceIn + cached * priceCached + summary.completionTokens * priceOut) / 1_000_000;

    const lines = [
      `📊 Consumo del modelo (${window.label}):`,
      `• ${fmt(summary.calls)} llamadas`,
      `• ${fmt(summary.promptTokens)} tokens de entrada${summary.cachedPromptTokens ? ` (${fmt(summary.cachedPromptTokens)} desde caché)` : ''} + ${fmt(summary.completionTokens)} de salida`,
      ...(priceIn > 0 || priceOut > 0 ? [`• Costo estimado: US$ ${cost.toFixed(cost < 1 ? 4 : 2)}`] : []),
    ];
    if (summary.topUsers.length > 0) {
      lines.push(
        '',
        'Quién más lo usa:',
        ...summary.topUsers.map((u, i) => `${i + 1}. ${u.user} — ${fmt(u.calls)} llamadas, ${fmt(u.tokens)} tokens`),
      );
    }
    if (summary.oldest && summary.oldest > since) {
      lines.push('', `⚠️ Solo hay registros desde ${summary.oldest.toLocaleString('es-ES')} (se guardan los últimos 5000).`);
    }

    const parts = this.splitForChat(lines.join('\n'), `@${authorUsername} `.length);
    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
    for (let i = 0; i < parts.length; i++) {
      this.sendBotMessage(i === 0 ? `@${authorUsername} ${parts[i]}` : parts[i]);
      if (i < parts.length - 1) await this.utilsService.sleep(responseDelay);
    }
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
    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
    const parts = this.splitForChat(message, `@${authorUsername} `.length);

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

  private stripAccents(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  }
}
