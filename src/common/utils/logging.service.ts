import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UtilsService } from './utils.service';
import { MessageLog, MessageLogDocument } from '../schemas/message-log.schema';
import { EventLog, EventLogDocument } from '../schemas/event-log.schema';
import { createLog } from './log';

const log = createLog('LoggingService');

const MESSAGES_CAP = 200;
const EVENTS_CAP = 200;

@Injectable()
export class LoggingService {
  constructor(
    private readonly configService: ConfigService,
    private readonly utilsService: UtilsService,
    @InjectModel(MessageLog.name) private readonly messageLogModel: Model<MessageLogDocument>,
    @InjectModel(EventLog.name) private readonly eventLogModel: Model<EventLogDocument>,
  ) {}

  /**
   * Los mensajes más nuevos del log (hasta `MESSAGES_CAP`), del más viejo al
   * más nuevo. Con `since`, sólo los posteriores: así `!resumen` cubre lo que
   * pasó desde el resumen anterior sin tener que vaciar el log (antes lo
   * vaciaba, y el bot se quedaba sin contexto de sala).
   */
  async getLastMessages(since?: Date | null): Promise<{ user: string; message: string }[]> {
    const filter = since ? { createdAt: { $gt: since } } : {};
    const rows = await this.messageLogModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(MESSAGES_CAP)
      .lean()
      .exec();
    return rows.reverse().map((r) => ({ user: r.user, message: r.message }));
  }

  /**
   * Los últimos `limit` mensajes de la sala dentro de los últimos `minutes`,
   * del más viejo al más nuevo. Alimenta el contexto de sala del modelo.
   * Incluye las respuestas del propio bot (ver `BotService.logOwnMessage`).
   */
  async getRecent(limit: number, minutes: number): Promise<{ user: string; message: string; at: Date }[]> {
    if (limit <= 0 || minutes <= 0) return [];
    const since = new Date(Date.now() - minutes * 60_000);
    const rows = await this.messageLogModel
      .find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean()
      .exec();
    return rows.reverse().map((r: any) => ({ user: r.user, message: r.message, at: r.createdAt }));
  }

  async saveLog(user: string, message: string): Promise<void> {
    const cleanUser = this.utilsService.cleanHtmlFromMessage(user);
    const cleanMessage = this.utilsService.cleanHtmlFromMessage(message);
    if (!cleanUser || !cleanMessage) return;

    await this.messageLogModel.create({ user: cleanUser, message: cleanMessage });

    // Trim to keep at most MESSAGES_CAP rows. Cheaper than scanning the whole
    // collection on every insert: only act when count exceeds cap by a margin.
    const total = await this.messageLogModel.estimatedDocumentCount();
    if (total > MESSAGES_CAP + 50) {
      const overflow = await this.messageLogModel
        .find()
        .sort({ createdAt: -1 })
        .skip(MESSAGES_CAP)
        .select({ _id: 1 })
        .lean()
        .exec();
      if (overflow.length > 0) {
        await this.messageLogModel.deleteMany({ _id: { $in: overflow.map((d) => d._id) } });
      }
    }
  }

  async saveEventsLog(event: string, user: string): Promise<void> {
    const cleanUser = this.utilsService.cleanHtmlFromMessage(user);
    await this.eventLogModel.create({ event, user: cleanUser, date: new Date() });

    const total = await this.eventLogModel.estimatedDocumentCount();
    if (total > EVENTS_CAP + 50) {
      const overflow = await this.eventLogModel
        .find()
        .sort({ createdAt: -1 })
        .skip(EVENTS_CAP)
        .select({ _id: 1 })
        .lean()
        .exec();
      if (overflow.length > 0) {
        await this.eventLogModel.deleteMany({ _id: { $in: overflow.map((d) => d._id) } });
      }
    }
  }

  async getLastEvents(): Promise<{ event: string; user: string; date: string }[]> {
    const rows = await this.eventLogModel
      .find()
      .sort({ createdAt: 1 })
      .limit(EVENTS_CAP)
      .lean()
      .exec();
    return rows.map((r) => ({ event: r.event, user: r.user, date: new Date(r.date).toISOString() }));
  }

  async getLastEventType(event: string): Promise<{ minutesLeft: number; lastResumenEvent: { event: string; user: string; date: string } | null }> {
    const last = await this.eventLogModel
      .findOne({ event })
      .sort({ date: -1 })
      .lean()
      .exec();
    if (!last) return { minutesLeft: 1000, lastResumenEvent: null };

    const lastDate = new Date(last.date);
    const minutesLeft = Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60));
    return {
      minutesLeft,
      lastResumenEvent: { event: last.event, user: last.user, date: lastDate.toISOString() },
    };
  }

  async cleanBotMessagesFromLog(botUsername: string): Promise<void> {
    if (!botUsername) return;
    const result = await this.messageLogModel.deleteMany({ user: botUsername });
    if (result.deletedCount && result.deletedCount > 0) {
      log.info(`🧹 Limpieza del log: ${result.deletedCount} mensajes del bot removidos`);
    }
  }
}
