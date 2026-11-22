import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Dueño del interruptor de `!video`. `BotService` (dispatcher) y
 * `BotCommandsService` (`!ayuda`, `!videos`) leen de acá y no de
 * `ConfigService`, así el override de `!videos on|off` los mueve a los dos.
 *
 * Mismo patrón que `CrossContextSettingsService`: `VIDEO_ENABLED` del `.env`
 * como default, override en memoria que se pierde al reiniciar.
 */
@Injectable()
export class VideoSettingsService {
  private override: boolean | null = null;

  constructor(private readonly configService: ConfigService) {}

  isEnabled(): boolean {
    if (this.override !== null) return this.override;
    return this.configService.get<boolean>('video.enabled') === true;
  }

  /** `null` limpia el override y devuelve el control al `.env`. */
  setOverride(value: boolean | null): void {
    this.override = value;
  }

  getInfo(): { enabled: boolean; source: 'env' | 'override' } {
    return {
      enabled: this.isEnabled(),
      source: this.override === null ? 'env' : 'override',
    };
  }
}
