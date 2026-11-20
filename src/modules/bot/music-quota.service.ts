import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Default de `MUSIC_MAX_PENDING_PER_USER`: canciones/videos en camino a la vez por persona. */
export const MAX_PENDING_PER_USER = 2;

/** Default de `MUSIC_MAX_PENDING_GLOBAL`: canciones/videos en camino a la vez en todo el chat. */
export const MAX_PENDING_GLOBAL = 8;

const HOUR_MS = 60 * 60_000;

/** Roles sin cupo por hora (sí respetan los topes de "en camino"). */
const STAFF_ROLES = new Set(['mod', 'admin', 'superAdmin']);

export type MusicAdmission =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'user_pending' | 'global_pending' | 'hourly'; limit: number };

/**
 * Límites de música y video. Antes el camino rápido de música iba antes del
 * rate limit de `RateLimitService` y la cola de `MusicService` no tenía tope:
 * cualquiera, incluido un invitado, podía encolar descargas y subidas sin fin.
 *
 * Tres reglas, en este orden, todas configurables por `.env` (0 = sin tope):
 *  1. pedidos en camino por persona: `MUSIC_MAX_PENDING_PER_USER` (2);
 *  2. pedidos en camino en todo el chat: `MUSIC_MAX_PENDING_GLOBAL` (8);
 *  3. un cupo por hora (ventana móvil): `MUSIC_PER_HOUR` para invitados (o sin
 *     rol, 5), `MUSIC_PER_HOUR_REGISTERED` para `user` (20); el staff no tiene
 *     cupo por hora.
 *
 * Todo en memoria (se reinicia con el proceso) y por nombre: igual que el
 * rate limit, un invitado que se cambia el nombre arranca con el cupo lleno.
 * Los dos topes de "en camino" acotan igual lo que eso puede costar.
 */
@Injectable()
export class MusicQuotaService {
  private readonly pending = new Map<string, number>();
  private pendingTotal = 0;
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly configService: ConfigService) {}

  /** Reloj inyectable para los tests. */
  protected now(): number {
    return Date.now();
  }

  /**
   * Pide lugar para un pedido. Si `ok`, hay que llamar a `release()` cuando el
   * pedido termine (bien o mal); es idempotente.
   */
  admit(username: string, role?: string): MusicAdmission {
    const key = (username ?? '').trim().toLowerCase();

    const perUser = this.configService.get<number>('music.maxPendingPerUser') ?? MAX_PENDING_PER_USER;
    const global = this.configService.get<number>('music.maxPendingGlobal') ?? MAX_PENDING_GLOBAL;

    const mine = this.pending.get(key) ?? 0;
    if (perUser > 0 && mine >= perUser) {
      return { ok: false, reason: 'user_pending', limit: perUser };
    }
    if (global > 0 && this.pendingTotal >= global) {
      return { ok: false, reason: 'global_pending', limit: global };
    }

    const hourly = this.hourlyLimit(role);
    if (hourly > 0) {
      const now = this.now();
      const fresh = (this.hits.get(key) ?? []).filter((t) => now - t < HOUR_MS);
      if (fresh.length >= hourly) {
        this.hits.set(key, fresh);
        return { ok: false, reason: 'hourly', limit: hourly };
      }
      fresh.push(now);
      this.hits.set(key, fresh);
    }

    this.pending.set(key, mine + 1);
    this.pendingTotal++;

    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const left = (this.pending.get(key) ?? 1) - 1;
        if (left > 0) this.pending.set(key, left);
        else this.pending.delete(key);
        this.pendingTotal = Math.max(0, this.pendingTotal - 1);
      },
    };
  }

  private hourlyLimit(role?: string): number {
    if (role && STAFF_ROLES.has(role)) return 0;
    if (role === 'user') return this.configService.get<number>('music.perHourRegistered') ?? 20;
    return this.configService.get<number>('music.perHour') ?? 5;
  }
}
