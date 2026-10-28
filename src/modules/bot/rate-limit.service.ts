import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Ventana deslizante de una hora para el límite de gasto por usuario. */
const WINDOW_MS = 60 * 60 * 1000;

/**
 * Cooldown propio (independiente de `WINDOW_MS`) para el AVISO de rechazo,
 * no para el límite en sí — ver `shouldNotifyRejection`. Cinco minutos deja
 * que alguien que se pasó de cupo escribiendo seguido reciba UN aviso y
 * después silencio, en vez de un aviso por mensaje.
 */
const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Cada tantas invocaciones a `check` se barre el Map completo, no sólo la
 * entrada del usuario que está consultando (ver `maybeSweep`). Un número
 * chico penaliza el throughput; uno enorme deja crecer la memoria durante
 * más tiempo entre barridos. 200 es un punto medio arbitrario para un bot
 * de un solo chat.
 */
const SWEEP_EVERY_N_CHECKS = 200;

/**
 * Guard de costo por usuario (Task 4, fase 5a): limita cuántas veces por
 * hora una persona puede disparar una llamada al modelo. `maxLengthResponse`
 * ya acotaba el tamaño de la respuesta; nada acotaba la frecuencia — una
 * tarde movida (o alguien probando adrede) se comía el presupuesto de todo
 * el chat.
 *
 * Guarda, en memoria, las marcas de tiempo de las llamadas aceptadas por
 * usuario normalizado (`trim().toLowerCase()`, para que "Nico", " nico " y
 * "NICO" cuenten como la misma persona). No hay Redis ni persistencia: como
 * el resto del estado en memoria del bot, se resetea si el proceso reinicia
 * — aceptable para un guard anti-abuso, no para un tope de facturación
 * exacto.
 */
@Injectable()
export class RateLimitService {
  constructor(private readonly configService: ConfigService) {}

  /** Marcas de tiempo (epoch ms) de llamadas aceptadas, por usuario normalizado. */
  private readonly hits = new Map<string, number[]>();

  /**
   * Último aviso de rechazo (epoch ms) enviado a cada usuario normalizado —
   * ver `shouldNotifyRejection`. Mapa aparte de `hits`: uno cuenta llamadas
   * ACEPTADAS dentro de la ventana de una hora, éste cuenta el último aviso
   * de rechazo dentro de una ventana de `NOTIFY_COOLDOWN_MS` mucho más corta.
   */
  private readonly lastNotifiedAt = new Map<string, number>();

  /** Contador de invocaciones desde el último barrido completo del Map. */
  private checksSinceSweep = 0;

  /**
   * `true` si `username` puede disparar otra llamada al modelo ahora mismo.
   *
   * - `admin`/`superAdmin` nunca se limitan (ni siquiera cuentan: no se
   *   registra marca de tiempo para ellos).
   * - Con `bot.rateLimitPerHour` en `0` el límite queda desactivado por
   *   completo — es el interruptor para apagar la feature sin tocar código.
   * - La ventana es móvil: se cuentan sólo las marcas de la última hora, no
   *   un contador que resetea en un límite de reloj fijo.
   */
  check(username: string, role?: string): boolean {
    if (role === 'admin' || role === 'superAdmin') return true;

    const limit = this.configService.get<number>('bot.rateLimitPerHour') ?? 20;
    if (limit <= 0) return true;

    const now = Date.now();
    this.maybeSweep(now);

    const key = this.normalize(username);
    const fresh = (this.hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

    if (fresh.length >= limit) {
      // Persistimos la lista ya podada aunque rechacemos: evita que una
      // marca vencida se siga arrastrando en llamadas futuras de esta misma
      // clave.
      this.hits.set(key, fresh);
      return false;
    }

    fresh.push(now);
    this.hits.set(key, fresh);
    return true;
  }

  /**
   * `true` sólo la primera vez que se llama para `username` dentro de una
   * ventana de `NOTIFY_COOLDOWN_MS` — pensado para que `BotService` avise UNA
   * vez que el usuario fue rate-limited y después se quede en silencio en
   * vez de responder a cada mensaje rechazado.
   *
   * Existe porque el bot corre con `role=bot`, que bypasea el anti-spam del
   * gateway (ver `chat.gateway.ts`) — sin este cooldown propio, alguien
   * pasado de cupo que siga escribiendo recibe un aviso por mensaje, y como
   * ese aviso no cuesta tokens pero sí un mensaje de chat por cada uno,
   * `check()` (que evita gastar tokens) terminaba abriendo un canal de flood
   * gratuito, justo para quien agota la cuota a propósito.
   *
   * Silencio total tampoco sirve — la persona no entendería por qué el bot
   * la empezó a ignorar sin avisar — así que el balance es "avisar una vez y
   * después callar" hasta que el cooldown expire.
   */
  shouldNotifyRejection(username: string): boolean {
    const key = this.normalize(username);
    const now = Date.now();
    const last = this.lastNotifiedAt.get(key);
    if (last !== undefined && now - last < NOTIFY_COOLDOWN_MS) return false;

    this.lastNotifiedAt.set(key, now);
    return true;
  }

  private normalize(username: string): string {
    return username.trim().toLowerCase();
  }

  /**
   * Poda el Map completo cada `SWEEP_EVERY_N_CHECKS` llamadas a `check`, no
   * sólo la entrada de quien está consultando ahora. Podar únicamente la
   * clave consultada (como ya hace `check` de paso) no alcanza para acotar
   * el crecimiento: alguien que pasó una sola vez por el chat no vuelve a
   * llamar a `check`, así que su entrada nunca se tocaría de nuevo y
   * quedaría en memoria para siempre. Este barrido periódico es lo que
   * garantiza que el Map no crezca sin límite con usuarios de paso.
   */
  private maybeSweep(now: number): void {
    this.checksSinceSweep += 1;
    if (this.checksSinceSweep < SWEEP_EVERY_N_CHECKS) return;
    this.checksSinceSweep = 0;

    for (const [key, lastNotified] of this.lastNotifiedAt) {
      if (now - lastNotified >= NOTIFY_COOLDOWN_MS) this.lastNotifiedAt.delete(key);
    }

    for (const [key, timestamps] of this.hits) {
      const fresh = timestamps.filter((t) => now - t < WINDOW_MS);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
  }
}
