import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** "mandame un sticker", "pasá un stiker", "estickers"… */
const EXPLICIT_REQUEST_RE = /\be?sti(?:ck|k|c)ers?\b/i;

export type StickerOffer = 'none' | 'optional' | 'requested';

/**
 * Decide en cada respuesta si al modelo se le ofrece mandar un sticker.
 *
 * La decisión de SI la toma el código, no el modelo: dejarla en el prompt
 * haría que el bot mande stickers cada vez que "encaja", que es casi siempre,
 * y la lista de nombres (~1k tokens) se pagaría en cada mensaje. El modelo
 * sólo elige CUÁL y puede igual decidir no mandar ninguno.
 *
 * - `requested`: el mensaje pide un sticker explícitamente. Ignora la
 *   probabilidad Y el cooldown — si alguien lo pide y el bot contesta sin
 *   sticker parece roto. El techo para ese caso es el `RATE_LIMIT_PER_HOUR`
 *   por usuario, que ya corre antes de llegar acá.
 * - `optional`: salió el dado (`STICKER_CHANCE`) y pasó el cooldown global
 *   (`STICKER_COOLDOWN_MINUTES`) desde el último sticker enviado.
 * - `none`: no se le menciona nada al modelo.
 *
 * El cooldown es global (todo el chat), en memoria, y se reinicia con el
 * proceso — igual que el resto del estado en caliente del bot.
 */
@Injectable()
export class StickerGateService {
  private lastSentAt = 0;
  /** Inyectable para tests. */
  random: () => number = Math.random;
  now: () => number = Date.now;

  constructor(private readonly configService: ConfigService) {}

  static isExplicitRequest(content: string): boolean {
    return EXPLICIT_REQUEST_RE.test(content ?? '');
  }

  decide(content: string): StickerOffer {
    if (StickerGateService.isExplicitRequest(content)) return 'requested';
    const chance = this.configService.get<number>('bot.stickerChance') ?? 0;
    if (chance <= 0) return 'none';
    const cooldownMs = (this.configService.get<number>('bot.stickerCooldownMinutes') ?? 5) * 60_000;
    if (this.now() - this.lastSentAt < cooldownMs) return 'none';
    return this.random() < chance ? 'optional' : 'none';
  }

  /** Llamar sólo cuando de verdad se envió un sticker: ofrecerlo y que el modelo pase no consume el cooldown. */
  markSent(): void {
    this.lastSentAt = this.now();
  }
}
