import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Interruptor de la memoria a largo plazo: `MEMORY_ENABLED` como default y
 * `!memoria on|off|reset` (admin) como override en memoria, que se pierde al
 * reiniciar. Mismo patrón que `CrossContextSettingsService`.
 */
@Injectable()
export class MemorySettingsService {
  private override: boolean | null = null;

  constructor(private readonly configService: ConfigService) {}

  isEnabled(): boolean {
    if (this.override !== null) return this.override;
    return this.configService.get<boolean>('memory.enabled') === true;
  }

  /** `null` limpia el override y devuelve el control al `.env`. */
  setOverride(value: boolean | null): void {
    this.override = value;
  }

  getInfo(): { enabled: boolean; source: 'env' | 'override' } {
    return { enabled: this.isEnabled(), source: this.override === null ? 'env' : 'override' };
  }
}
