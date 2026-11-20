import { Injectable, Logger } from '@nestjs/common';
import { FORMAT_BBCODES, FormatBbcode, normalizeDisabledBbcodes } from '../../common/bbcode/bbcode';

/**
 * BBCodes de formato que el admin apagó desde `/admin/bbcode`.
 *
 * Mismo patrón que `StickerCatalogService`: se llena desde el socket. La
 * lista llega en el `init` de cada conexión (`theme.disabledBbcodes`) y en
 * vivo con `bbcodesState { disabled }`. Sin dato, todos activos (igual que en
 * el chat: un settings sin el campo los ve todos encendidos).
 */
@Injectable()
export class BbcodeSettingsService {
  private readonly logger = new Logger(BbcodeSettingsService.name);
  private disabledSet: ReadonlySet<FormatBbcode> = new Set();

  update(disabled: unknown): void {
    const next = new Set(normalizeDisabledBbcodes(disabled));
    const changed =
      next.size !== this.disabledSet.size || [...next].some((t) => !this.disabledSet.has(t));
    this.disabledSet = next;
    if (changed) {
      this.logger.log(`🔤 BBCodes apagados: ${next.size > 0 ? [...next].join(', ') : 'ninguno'}`);
    }
  }

  get disabled(): ReadonlySet<string> {
    return this.disabledSet;
  }

  /** Los que el bot puede usar, en el orden oficial. */
  enabled(): FormatBbcode[] {
    return FORMAT_BBCODES.filter((t) => !this.disabledSet.has(t));
  }
}
