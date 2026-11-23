import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BotFollowup, BotFollowupDocument } from '../../common/schemas/bot-followup.schema';
import { BotMemory, BotMemoryDocument } from '../../common/schemas/bot-memory.schema';
import { afterWindow, beforeDueAt, localDayKey, localToUtc, addDays } from './memory-time';

const userKeyOf = (username: string): string => (username ?? '').trim().toLowerCase();

/**
 * Seguimientos de los eventos: la suerte del día (`before`, sale sola a su
 * hora) y el "¿cómo te fue?" (`after`, cuando la persona aparece). Los dos se
 * reclaman con `findOneAndUpdate` para que dos ticks o dos mensajes seguidos
 * no los manden dos veces. Como mucho uno por persona por día local.
 */
@Injectable()
export class FollowupService {
  constructor(
    @InjectModel(BotFollowup.name) private readonly model: Model<BotFollowupDocument>,
    @InjectModel(BotMemory.name) private readonly memories: Model<BotMemoryDocument>,
  ) {}

  async schedule(memory: BotMemoryDocument, now = new Date()): Promise<void> {
    if (memory.kind !== 'event' || !memory.eventDate) return;
    const base = { userKey: memory.userKey, username: memory.username, memoryId: memory._id as Types.ObjectId, status: 'pending' as const };
    const docs: Partial<BotFollowup>[] = [];

    const before = beforeDueAt(memory.eventDate, memory.eventTime ?? undefined);
    if (!memory.sensitive && before.getTime() > now.getTime()) {
      docs.push({ ...base, phase: 'before', dueAt: before, expiresAt: localToUtc(addDays(memory.eventDate, 2), '00:00') });
    }
    const { from, expiresAt } = afterWindow(memory.eventDate);
    docs.push({ ...base, phase: 'after', dueAt: from, expiresAt });
    await this.model.insertMany(docs);
  }

  async reschedule(memory: BotMemoryDocument, now = new Date()): Promise<void> {
    await this.cancelFor(String(memory._id));
    await this.schedule(memory, now);
  }

  async cancelFor(memoryId: string): Promise<void> {
    if (!Types.ObjectId.isValid(memoryId)) return;
    await this.model.updateMany({ memoryId: new Types.ObjectId(memoryId), status: 'pending' }, { $set: { status: 'skipped' } });
  }

  async cancelAllFor(username: string): Promise<void> {
    await this.model.updateMany({ userKey: userKeyOf(username), status: 'pending' }, { $set: { status: 'skipped' } });
  }

  /** Suertes vencidas, reclamadas de a una. Las que ya no corresponden se marcan `skipped`. */
  async claimDueBefore(now = new Date(), max = 20): Promise<Array<{ user: string; memory: BotMemoryDocument }>> {
    const out: Array<{ user: string; memory: BotMemoryDocument }> = [];
    for (let i = 0; i < max; i++) {
      const claimed = await this.model.findOneAndUpdate(
        { phase: 'before', status: 'pending', dueAt: { $lte: now } },
        { $set: { status: 'sent', sentAt: now } },
        { sort: { dueAt: 1 }, new: true },
      );
      if (!claimed) break;
      const memory = await this.memories.findById(claimed.memoryId);
      if (!memory || memory.status !== 'active' || this.eventPassed(memory, now) || (await this.sentToday(claimed, now))) {
        await this.skip(claimed);
        continue;
      }
      out.push({ user: claimed.username, memory });
    }
    return out;
  }

  /** El "¿cómo te fue?" disponible más viejo de esa persona, si hoy no recibió otro seguimiento. */
  async claimAfter(username: string, now = new Date()): Promise<BotMemoryDocument | null> {
    const userKey = userKeyOf(username);
    if (await this.model.exists({ userKey, status: 'sent', sentAt: { $gte: this.dayStart(now) } })) return null;
    for (;;) {
      const claimed = await this.model.findOneAndUpdate(
        { userKey, phase: 'after', status: 'pending', dueAt: { $lte: now }, expiresAt: { $gt: now } },
        { $set: { status: 'sent', sentAt: now } },
        { sort: { dueAt: 1 }, new: true },
      );
      if (!claimed) return null;
      const memory = await this.memories.findById(claimed.memoryId);
      if (memory && memory.status === 'active' && !(await this.sentToday(claimed, now))) return memory;
      await this.skip(claimed);
    }
  }

  private eventPassed(memory: BotMemoryDocument, now: Date): boolean {
    if (!memory.eventDate) return true;
    if (memory.eventTime) return localToUtc(memory.eventDate, memory.eventTime).getTime() <= now.getTime();
    return memory.eventDate < localDayKey(now);
  }

  /** ¿Esa persona ya recibió OTRO seguimiento hoy? */
  private async sentToday(claimed: BotFollowupDocument, now: Date): Promise<boolean> {
    return !!(await this.model.exists({
      _id: { $ne: claimed._id },
      userKey: claimed.userKey,
      status: 'sent',
      sentAt: { $gte: this.dayStart(now) },
    }));
  }

  private dayStart(now: Date): Date {
    return localToUtc(localDayKey(now), '00:00');
  }

  private async skip(claimed: BotFollowupDocument): Promise<void> {
    await this.model.updateOne({ _id: claimed._id }, { $set: { status: 'skipped', sentAt: null } });
  }
}
