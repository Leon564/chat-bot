import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Dueño ÚNICO del interruptor de contexto cruzado. Los tres consumidores
 * (lectura cruzada en `GraphContextService`, hechos sobre terceros en
 * `ChatService`, recados en `BotService`) leen de acá y no de `ConfigService`
 * directamente: si cada uno leyera el `.env` por su cuenta, el override en
 * runtime de `!contextocruzado` movería a unos y no a otros, y la feature
 * quedaría a medio encender sin que nadie lo note.
 *
 * Mismo patrón que el override de personalidad (`ChatService`): valor del
 * `.env` como default, override en memoria que se pierde al reiniciar.
 */
@Injectable()
export class CrossContextSettingsService {
  private override: boolean | null = null;

  constructor(private readonly configService: ConfigService) {}

  isEnabled(): boolean {
    if (this.override !== null) return this.override;
    return this.configService.get<boolean>('bot.crossUserContext') === true;
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
