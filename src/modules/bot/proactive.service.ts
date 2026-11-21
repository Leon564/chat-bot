import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Mensajes mínimos y personas distintas en la charla reciente para meterse. */
export const PROACTIVE_MIN_MESSAGES = 4;
export const PROACTIVE_MIN_PEOPLE = 2;
/** Largo mínimo del mensaje que dispara el intento ("jaja" o "ok" no). */
export const PROACTIVE_MIN_CHARS = 12;

/**
 * Decide cuándo el bot comenta algo SIN que lo nombren, como uno más del
 * chat. Todo en código y barato antes de gastar una llamada al modelo:
 * probabilidad (`PROACTIVE_CHANCE`), pausa global entre intentos
 * (`PROACTIVE_COOLDOWN_MINUTES`), mensaje con algo de contenido y una charla
 * viva (varias personas hablando hace poco). Aun así el modelo puede pasar
 * (responde "PASO") si no tiene nada que aportar.
 *
 * El override en memoria (`!proactivo on|off|reset`) es el interruptor de
 * emergencia sin reiniciar, mismo patrón que `!sharedcontext`.
 */
@Injectable()
export class ProactiveService {
  private lastAttemptAt = 0;
  private override: boolean | null = null;
  /** Overrides en memoria de `!proactivo <n>%` y `!proactivo pausa <min>`. */
  private chanceOverride: number | null = null;
  private cooldownOverrideMin: number | null = null;
  /** Inyectables para tests. */
  random: () => number = Math.random;
  now: () => number = Date.now;

  constructor(private readonly configService: ConfigService) {}

  private chance(): number {
    return this.chanceOverride ?? this.configService.get<number>('bot.proactiveChance') ?? 0;
  }

  private cooldownMs(): number {
    return (this.cooldownOverrideMin ?? this.configService.get<number>('bot.proactiveCooldownMinutes') ?? 15) * 60_000;
  }

  /** Probabilidad por mensaje, 0..1 (se recorta). 0 apaga. */
  setChance(value: number): void {
    this.chanceOverride = Math.min(1, Math.max(0, value));
    this.override = null;
  }

  /** Pausa mínima entre intentos, en minutos (mínimo 1). */
  setCooldownMinutes(value: number): void {
    this.cooldownOverrideMin = Math.max(1, value);
  }

  isEnabled(): boolean {
    if (this.override !== null) return this.override;
    return this.chance() > 0;
  }

  /** `null` = volver a todo lo del .env (encendido, probabilidad y pausa). */
  setOverride(value: boolean | null): void {
    this.override = value;
    if (value === null) {
      this.chanceOverride = null;
      this.cooldownOverrideMin = null;
    }
  }

  getInfo(): { enabled: boolean; source: 'env' | 'override'; chance: number; cooldownMinutes: number } {
    return {
      enabled: this.isEnabled(),
      source: this.override === null && this.chanceOverride === null && this.cooldownOverrideMin === null ? 'env' : 'override',
      chance: this.chance(),
      cooldownMinutes: this.cooldownMs() / 60_000,
    };
  }

  /** Filtro barato (sin Mongo ni modelo) sobre el mensaje que acaba de llegar. */
  shouldTry(content: string): boolean {
    if (!this.isEnabled()) return false;
    const text = (content ?? '').trim();
    if (text.length < PROACTIVE_MIN_CHARS) return false;
    if (/^[!/]/.test(text)) return false;
    if (/^:[\w]+:$/.test(text)) return false;
    if (this.now() - this.lastAttemptAt < this.cooldownMs()) return false;
    // Con el override encendido y la probabilidad del .env en 0, se usa un
    // 5 % para que "on" haga algo.
    const chance = this.chance() > 0 ? this.chance() : 0.05;
    return this.random() < chance;
  }

  /** ¿Hay una charla viva? (varios mensajes de varias personas, sin contar al bot). */
  static isLively(rows: { user: string; message: string }[], botName: string | undefined): boolean {
    const bot = (botName ?? '').trim().toLowerCase();
    const people = rows.filter((r) => r.user && r.user.trim().toLowerCase() !== bot);
    const distinct = new Set(people.map((r) => r.user.trim().toLowerCase()));
    return people.length >= PROACTIVE_MIN_MESSAGES && distinct.size >= PROACTIVE_MIN_PEOPLE;
  }

  /** Se llama justo antes de la llamada al modelo: la pausa cuenta desde el intento, hable o pase. */
  markAttempt(): void {
    this.lastAttemptAt = this.now();
  }
}
