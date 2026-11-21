import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UtilsService } from '../../common/utils/utils.service';
import { ChatSocketService } from '../chat-socket/chat-socket.service';
import { BbcodeSettingsService } from '../chat-socket/bbcode-settings.service';
import { isOnlyCaretColor, rebalanceBbcodeParts, sanitizeBotBbcode } from '../../common/bbcode/bbcode';

/**
 * Todo lo que el bot manda al chat pasa por acá: prefijo de color, red de
 * seguridad de BBCode y corte en partes que el backend acepte. Separado de
 * `BotService` para que los comandos (`BotCommandsService`) usen exactamente
 * la misma salida.
 */
@Injectable()
export class BotOutputService {
  constructor(
    private readonly configService: ConfigService,
    private readonly chatSocketService: ChatSocketService,
    private readonly utilsService: UtilsService,
    // Opcional: sin él se asumen todos los BBCodes encendidos.
    @Optional() private readonly bbcodeSettings?: BbcodeSettingsService,
  ) {}

  /** Prefijo de color estilo cbox (`^#rrggbb `) que lleva todo mensaje del bot. */
  colorPrefix(): string {
    const color = this.configService.get<string>('bot.textColor') || process.env.TEXT_COLOR || '';
    return color ? `^#${color} ` : '';
  }

  /**
   * Pasa el texto por la red de seguridad de BBCode antes de enviarlo: un tag
   * vacío (`[b][/b]`) hace que el backend descarte el mensaje entero en
   * silencio, y uno apagado por el admin se vería como `[*]texto`. Devuelve
   * `null` si no queda nada visible para mandar.
   */
  prepareOutgoing(text: string): string | null {
    const clean = sanitizeBotBbcode(text, this.bbcodeSettings?.disabled ?? new Set()).trim();
    if (!clean || isOnlyCaretColor(clean)) return null;
    return `${this.colorPrefix()}${clean}`;
  }

  /** Send a bot message prefixed with the configured color code if provided */
  sendBotMessage(text: string): void {
    const content = this.prepareOutgoing(text);
    if (content) this.chatSocketService.sendMessage(content);
  }

  /** Same as sendBotMessage but resolves with the server-assigned message _id */
  sendBotMessageAndAwaitId(text: string): Promise<string | null> {
    const content = this.prepareOutgoing(text);
    if (!content) return Promise.resolve(null);
    return this.chatSocketService.sendMessageAndAwaitId(content);
  }

  /**
   * Parte un texto largo en mensajes que el backend acepte. El tope del
   * servidor para el bot (`maxBotMessageLength`, default 2000) cuenta el
   * mensaje entero, y uno que lo pase se DESCARTA en silencio; por eso al
   * `maxLengthResponse` se le descuentan el prefijo de color y `overhead`
   * (mención o encabezado que el llamador antepone).
   *
   * Después del corte, los BBCodes que quedaron abiertos se cierran y se
   * reabren en la parte siguiente (`rebalanceBbcodeParts`). Eso agrega
   * caracteres, así que si alguna parte se pasa se vuelve a cortar con menos
   * presupuesto.
   */
  splitForChat(text: string, overhead: number): string[] {
    const maxLength = this.configService.get<number>('bot.maxLengthResponse') || 2000;
    const limit = Math.max(50, maxLength - this.colorPrefix().length - overhead);
    let budget = limit;
    let parts: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      parts = rebalanceBbcodeParts(this.utilsService.splitMessageIntoParts(text, budget));
      const longest = Math.max(0, ...parts.map((p) => p.length));
      if (longest <= limit) break;
      budget = Math.max(20, budget - (longest - limit) - 10);
    }
    return parts;
  }
}
