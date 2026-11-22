import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Cómo se entrega un `!video`:
 * - `youtube`: `[youtube]ID[/youtube]`, sin descargar ni subir nada (no gasta
 *   el espacio de FileGarden). Es el default.
 * - `upload`: descarga el mp4 y lo sube por la cadena de subidas.
 */
export type VideoMode = 'youtube' | 'upload';

/**
 * Dueño de los dos interruptores de `!video`: si está habilitado y de qué
 * forma se entrega. `BotService` (dispatcher) y `BotCommandsService`
 * (`!ayuda`, `!videos`) leen de acá y no de `ConfigService`, así los
 * overrides de `!videos` los mueven a los dos.
 *
 * Mismo patrón que `CrossContextSettingsService`: `VIDEO_ENABLED` /
 * `VIDEO_MODE` del `.env` como default, overrides en memoria que se pierden
 * al reiniciar.
 */
@Injectable()
export class VideoSettingsService {
  private override: boolean | null = null;
  private modeOverride: VideoMode | null = null;

  constructor(private readonly configService: ConfigService) {}

  isEnabled(): boolean {
    if (this.override !== null) return this.override;
    return this.configService.get<boolean>('video.enabled') === true;
  }

  /** `null` limpia el override y devuelve el control al `.env`. */
  setOverride(value: boolean | null): void {
    this.override = value;
  }

  getMode(): VideoMode {
    if (this.modeOverride !== null) return this.modeOverride;
    return this.configService.get<string>('video.mode') === 'upload' ? 'upload' : 'youtube';
  }

  /** `null` limpia el override y devuelve el control al `.env`. */
  setModeOverride(mode: VideoMode | null): void {
    this.modeOverride = mode;
  }

  getInfo(): { enabled: boolean; source: 'env' | 'override'; mode: VideoMode; modeSource: 'env' | 'override' } {
    return {
      enabled: this.isEnabled(),
      source: this.override === null ? 'env' : 'override',
      mode: this.getMode(),
      modeSource: this.modeOverride === null ? 'env' : 'override',
    };
  }
}
