import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BotMemory, BotMemoryDocument } from '../../common/schemas/bot-memory.schema';
import { MemoryDraft } from './memory.types';
import { addDays, localDayKey, localToUtc } from './memory-time';
import { FollowupService } from './followup.service';

export const MAX_ACTIVE_MEMORIES = 50;
export const MAX_NEW_PER_DAY = 5;
/** Un evento pasa a `done` estos días después de su fecha. */
export const EVENT_DONE_AFTER_DAYS = 7;
/** Dos eventos de la misma fecha con al menos estas claves en común son el mismo. */
const SAME_EVENT_SHARED_KEYWORDS = 2;

export type CreateMemoryResult = 'created' | 'updated' | 'duplicate' | 'daily_cap';

/** Misma regla que `GraphService.normalizeUserKey`. */
export const memoryUserKey = (username: string): string => (username ?? '').trim().toLowerCase();

/** Para detectar el mismo recuerdo escrito dos veces. */
const normalizeText = (text: string): string =>
  (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Acceso a `bot_memories` con los topes del diseño: 50 activos por persona
 * (se poda el menos usado, nunca un evento futuro), 5 nuevos por día local, y
 * sin duplicados (el mismo texto dos veces actualiza la fecha si cambió).
 */
@Injectable()
export class MemoryStore {
  constructor(
    @InjectModel(BotMemory.name) private readonly model: Model<BotMemoryDocument>,
    // Opcional: cerrar/olvidar cancela los seguimientos si el servicio está.
    @Optional() private readonly followups?: FollowupService,
  ) {}

  async create(
    username: string,
    draft: MemoryDraft,
    now = new Date(),
  ): Promise<{ result: CreateMemoryResult; memory?: BotMemoryDocument }> {
    const userKey = memoryUserKey(username);
    const key = normalizeText(draft.text);
    const active = await this.listActive(username, now);

    const same =
      active.find((m) => normalizeText(m.text) === key) ??
      // El modelo casi nunca repite la frase exacta: un evento de la misma
      // fecha que comparte dos claves es el mismo.
      (draft.kind === 'event' && draft.eventDate
        ? active.find(
            (m) =>
              m.kind === 'event' &&
              m.eventDate === draft.eventDate &&
              m.keywords.filter((k) => draft.keywords.includes(k)).length >= SAME_EVENT_SHARED_KEYWORDS,
          )
        : undefined);
    if (same) {
      const moved =
        draft.eventDate && (draft.eventDate !== same.eventDate || (draft.eventTime ?? null) !== (same.eventTime ?? null));
      if (!moved) return { result: 'duplicate', memory: same };
      const updated = await this.reschedule(String(same._id), draft.eventDate!, draft.eventTime);
      return { result: 'updated', memory: updated ?? same };
    }

    const today = localDayKey(now);
    const createdToday = await this.model.countDocuments({ userKey, createdAt: { $gte: localToUtc(today, '00:00') } });
    if (createdToday >= MAX_NEW_PER_DAY) return { result: 'daily_cap' };

    if (active.length >= MAX_ACTIVE_MEMORIES) await this.pruneOne(userKey, today);

    const memory = await this.model.create({
      userKey,
      username: username.trim(),
      kind: draft.kind,
      text: draft.text,
      keywords: draft.keywords,
      eventDate: draft.eventDate ?? null,
      eventTime: draft.eventTime ?? null,
      sensitive: draft.sensitive,
      status: 'active',
      // Explícito: el tope diario cuenta por `createdAt` y los tests usan un reloj propio.
      createdAt: now,
    });
    return { result: 'created', memory };
  }

  /** Activos de la persona, del más viejo al más nuevo. Vence de paso los eventos viejos. */
  async listActive(username: string, now = new Date()): Promise<BotMemoryDocument[]> {
    const userKey = memoryUserKey(username);
    const cutoff = addDays(localDayKey(now), -EVENT_DONE_AFTER_DAYS);
    await this.model.updateMany(
      { userKey, status: 'active', kind: 'event', eventDate: { $ne: null, $lt: cutoff } },
      { $set: { status: 'done' } },
    );
    return this.model.find({ userKey, status: 'active' }).sort({ createdAt: 1, _id: 1 }).exec();
  }

  async findOwned(username: string, id: string): Promise<BotMemoryDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.model.findOne({ _id: id, userKey: memoryUserKey(username), status: 'active' }).exec();
  }

  async reschedule(id: string, eventDate: string, eventTime?: string): Promise<BotMemoryDocument | null> {
    return this.model
      .findByIdAndUpdate(id, { $set: { eventDate, eventTime: eventTime ?? null } }, { new: true })
      .exec();
  }

  async close(id: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { status: 'done' } });
    await this.followups?.cancelFor(id);
  }

  async forgetByPosition(username: string, position: number, now = new Date()): Promise<BotMemoryDocument | null> {
    const active = await this.listActive(username, now);
    const target = Number.isInteger(position) && position >= 1 ? active[position - 1] : undefined;
    if (!target) return null;
    await this.model.deleteOne({ _id: target._id });
    await this.followups?.cancelFor(String(target._id));
    return target;
  }

  async countActive(username: string, now = new Date()): Promise<number> {
    return (await this.listActive(username, now)).length;
  }

  async forgetAll(username: string): Promise<number> {
    const { deletedCount } = await this.model.deleteMany({ userKey: memoryUserKey(username) });
    await this.followups?.cancelAllFor(username);
    return deletedCount ?? 0;
  }

  async setEmbedding(id: string, model: string, vector: number[]): Promise<void> {
    await this.model.updateOne({ _id: id }, { $pull: { embeddings: { model } } });
    await this.model.updateOne({ _id: id }, { $push: { embeddings: { model, vector } } });
  }

  async markUsed(ids: string[], now = new Date()): Promise<void> {
    if (ids.length === 0) return;
    await this.model.updateMany({ _id: { $in: ids } }, { $inc: { useCount: 1 }, $set: { lastUsedAt: now } });
  }

  /** Borra el menos usado y más viejo, nunca un evento de hoy en adelante. */
  private async pruneOne(userKey: string, today: string): Promise<void> {
    const victim = await this.model
      .findOne({
        userKey,
        status: 'active',
        $nor: [{ kind: 'event', eventDate: { $gte: today } }],
      })
      .sort({ useCount: 1, lastUsedAt: 1, createdAt: 1 })
      .exec();
    if (victim) await this.model.deleteOne({ _id: victim._id });
  }
}
