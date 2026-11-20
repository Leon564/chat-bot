import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  RoomInstruction,
  RoomInstructionDocument,
} from '../../common/schemas/room-instruction.schema';

/** Tope de instrucciones vigentes: cada una va en TODOS los prompts. */
export const MAX_ROOM_INSTRUCTIONS = 10;

/** Largo máximo de una instrucción (se recorta, no se rechaza). */
export const MAX_ROOM_INSTRUCTION_LENGTH = 300;

/** Roles que pueden dar instrucciones en lenguaje natural (SAVE_INSTRUCTION). */
export const INSTRUCTION_STAFF_ROLES: ReadonlySet<string> = new Set(['mod', 'admin', 'superAdmin']);

/** Vencimiento mínimo y máximo aceptado para una instrucción temporal. */
export const MIN_INSTRUCTION_TTL_MS = 60_000;
export const MAX_INSTRUCTION_TTL_MS = 30 * 24 * 60 * 60_000;

export interface RoomInstructionView {
  text: string;
  createdBy: string;
  source: 'command' | 'model';
  /** `null` = permanente. */
  expiresAt: Date | null;
}

/**
 * Sin unión discriminada a propósito: el tsconfig del bot no tiene
 * `strictNullChecks`, y sin eso TS no estrecha por `ok`.
 */
export interface AddInstructionResult {
  ok: boolean;
  /** Posición (1-based) cuando `ok`. */
  position?: number;
  reason?: 'empty' | 'duplicate' | 'full' | 'error';
}

/**
 * Instrucciones permanentes de la sala. La lista se lee una vez de Mongo y se
 * mantiene en memoria: se consulta en cada respuesta del bot, y las únicas
 * escrituras pasan por este servicio. Igual que los topes de recados, esto
 * supone un solo proceso del bot (ver CLAUDE.md, `ErrandService`).
 *
 * El orden es por fecha de alta, y el número que ve el admin en
 * `!instrucciones` es la posición en esa lista (1-based), que es la que usa
 * `!instruccion quitar N`.
 */
@Injectable()
export class RoomInstructionsService {
  private readonly logger = new Logger(RoomInstructionsService.name);
  private cache: Array<RoomInstructionView & { id: string }> | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    @InjectModel(RoomInstruction.name)
    private readonly model: Model<RoomInstructionDocument>,
  ) {}

  static normalize(text: string): string {
    const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
    return oneLine.slice(0, MAX_ROOM_INSTRUCTION_LENGTH).trim();
  }

  /**
   * Convierte "30m", "2h", "1d" (también "90min", "3 dias") en milisegundos.
   * `null` si no es una duración o queda fuera de rango.
   */
  static parseDuration(raw: string): number | null {
    const m = (raw ?? '').trim().toLowerCase().match(/^(\d{1,4})\s*(m|min|mins|minutos?|h|hs|horas?|d|dias?|días?)$/);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2][0];
    const ms = n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
    return ms >= MIN_INSTRUCTION_TTL_MS && ms <= MAX_INSTRUCTION_TTL_MS ? ms : null;
  }

  async list(): Promise<RoomInstructionView[]> {
    const live = await this.live();
    return live.map(({ text, createdBy, source, expiresAt }) => ({ text, createdBy, source, expiresAt }));
  }

  /** Sólo los textos, para el prompt. Nunca lanza: sin lista, sin bloque. */
  async texts(): Promise<string[]> {
    try {
      return (await this.live()).map((i) => i.text);
    } catch {
      return [];
    }
  }

  /** `ttlMs` opcional: sin él la instrucción dura hasta que la quiten. */
  async add(
    text: string,
    createdBy: string,
    source: 'command' | 'model',
    ttlMs?: number | null,
  ): Promise<AddInstructionResult> {
    const clean = RoomInstructionsService.normalize(text);
    if (!clean) return { ok: false, reason: 'empty' };

    try {
      const list = await this.live();
      if (list.some((i) => i.text.toLowerCase() === clean.toLowerCase())) {
        return { ok: false, reason: 'duplicate' };
      }
      if (list.length >= MAX_ROOM_INSTRUCTIONS) return { ok: false, reason: 'full' };

      const expiresAt = ttlMs ? new Date(this.now() + ttlMs) : null;
      const doc = await this.model.create({ text: clean, createdBy, source, expiresAt });
      list.push({ id: String(doc._id), text: clean, createdBy, source, expiresAt });
      return { ok: true, position: list.length };
    } catch (err) {
      this.logger.warn(`No se pudo guardar la instrucción: ${(err as Error)?.message}`);
      return { ok: false, reason: 'error' };
    }
  }

  /** Quita la instrucción número `position` (1-based). Devuelve la quitada o null. */
  async removeAt(position: number): Promise<RoomInstructionView | null> {
    const list = await this.live();
    if (!Number.isInteger(position) || position < 1 || position > list.length) return null;

    const target = list[position - 1];
    await this.model.deleteOne({ _id: target.id }).exec();
    list.splice(position - 1, 1);
    return { text: target.text, createdBy: target.createdBy, source: target.source, expiresAt: target.expiresAt };
  }

  /** Borra todas. Devuelve cuántas había. */
  async clear(): Promise<number> {
    const count = (await this.live()).length;
    await this.model.deleteMany({}).exec();
    this.cache = [];
    return count;
  }

  /** Reloj inyectable para los tests. */
  protected now(): number {
    return Date.now();
  }

  /**
   * La caché sin las vencidas. Las saca de la caché en el momento (así los
   * números de `!instrucciones` y de `quitar` siempre coinciden) y las borra
   * de Mongo de fondo, sin esperar al barrido del índice TTL.
   */
  private async live(): Promise<Array<RoomInstructionView & { id: string }>> {
    await this.ensureLoaded();
    const list = this.cache ?? [];
    const now = this.now();
    const expired = list.filter((i) => i.expiresAt && i.expiresAt.getTime() <= now);
    if (expired.length > 0) {
      this.cache = list.filter((i) => !expired.includes(i));
      void this.model
        .deleteMany({ _id: { $in: expired.map((i) => i.id) } })
        .exec()
        .catch(() => {});
    }
    return this.cache ?? [];
  }

  private async ensureLoaded(): Promise<void> {
    if (this.cache) return;
    if (!this.loading) {
      this.loading = (async () => {
        const rows = await this.model.find({}).sort({ createdAt: 1, _id: 1 }).lean().exec();
        this.cache = rows.map((r) => ({
          id: String(r._id),
          text: r.text,
          createdBy: r.createdBy,
          source: r.source,
          expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
        }));
      })().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }
}
