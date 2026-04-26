import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UtilsService } from './utils.service';
import { MessageLog, MessageLogDocument } from '../schemas/message-log.schema';
import { EventLog, EventLogDocument } from '../schemas/event-log.schema';

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

  async getLastMessages(): Promise<{ user: string; message: string }[]> {
    const rows = await this.messageLogModel
      .find()
      .sort({ createdAt: 1 })
      .limit(MESSAGES_CAP)
      .lean()
      .exec();
    return rows.map((r) => ({ user: r.user, message: r.message }));
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

  async clearMessagesLog(): Promise<number> {
    const before = await this.messageLogModel.estimatedDocumentCount();
    await this.messageLogModel.deleteMany({});
    console.log(`📝 Log de mensajes limpiado: ${before} mensajes eliminados`);
    return before;
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
      console.log(`🧹 Limpieza del log: ${result.deletedCount} mensajes del bot removidos`);
    }
  }
}
