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

export interface RoomInstructionView {
  text: string;
  createdBy: string;
  source: 'command' | 'model';
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

  async list(): Promise<RoomInstructionView[]> {
    await this.ensureLoaded();
    return (this.cache ?? []).map(({ text, createdBy, source }) => ({ text, createdBy, source }));
  }

  /** Sólo los textos, para el prompt. Nunca lanza: sin lista, sin bloque. */
  async texts(): Promise<string[]> {
    try {
      await this.ensureLoaded();
      return (this.cache ?? []).map((i) => i.text);
    } catch {
      return [];
    }
  }

  async add(text: string, createdBy: string, source: 'command' | 'model'): Promise<AddInstructionResult> {
    const clean = RoomInstructionsService.normalize(text);
    if (!clean) return { ok: false, reason: 'empty' };

    try {
      await this.ensureLoaded();
      const list = this.cache ?? [];
      if (list.some((i) => i.text.toLowerCase() === clean.toLowerCase())) {
        return { ok: false, reason: 'duplicate' };
      }
      if (list.length >= MAX_ROOM_INSTRUCTIONS) return { ok: false, reason: 'full' };

      const doc = await this.model.create({ text: clean, createdBy, source });
      list.push({ id: String(doc._id), text: clean, createdBy, source });
      this.cache = list;
      return { ok: true, position: list.length };
    } catch (err) {
      this.logger.warn(`No se pudo guardar la instrucción: ${(err as Error)?.message}`);
      return { ok: false, reason: 'error' };
    }
  }

  /** Quita la instrucción número `position` (1-based). Devuelve la quitada o null. */
  async removeAt(position: number): Promise<RoomInstructionView | null> {
    await this.ensureLoaded();
    const list = this.cache ?? [];
    if (!Number.isInteger(position) || position < 1 || position > list.length) return null;

    const target = list[position - 1];
    await this.model.deleteOne({ _id: target.id }).exec();
    list.splice(position - 1, 1);
    return { text: target.text, createdBy: target.createdBy, source: target.source };
  }

  /** Borra todas. Devuelve cuántas había. */
  async clear(): Promise<number> {
    await this.ensureLoaded();
    const count = this.cache?.length ?? 0;
    await this.model.deleteMany({}).exec();
    this.cache = [];
    return count;
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
        }));
      })().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }
}
