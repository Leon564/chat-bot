import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Reminder, ReminderDocument } from '../../common/schemas/reminder.schema';
import { UtilsService } from '../../common/utils/utils.service';

export const MAX_PENDING_REMINDERS = 5;
export const MAX_REMINDER_TEXT = 200;
export const MIN_REMINDER_MS = 60_000;
export const MAX_REMINDER_MS = 30 * 24 * 60 * 60_000;

/** El Salvador: UTC-6 todo el año (sin horario de verano). */
const SV_OFFSET_MS = 6 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type CreateReminderResult = 'ok' | 'full' | 'invalid' | 'too_soon' | 'too_far';

export interface PendingReminder {
  text: string;
  dueAt: Date;
}

/** Verbo de "recordame" / "avisame", con o sin tilde. */
const INTENT_RE = /\b(recu[eé]rdame|record[aá]me|recordarme|av[ií]same|avisarme)\b/i;

/** "en 2 horas", "dentro de media hora", "en un día", "en 15 min". */
const RELATIVE_RE =
  /\b(?:en|dentro\s+de)\s+(\d+(?:[.,]\d+)?|un|una|media)\s*(minutos?|mins?|m|horas?|hrs?|hs|h|d[ií]as?|d)\b/i;

/** "a las 9", "mañana a las 21:30", "a la 1 de la tarde", "a las 8 pm". */
const ABSOLUTE_RE =
  /\b(ma[ñn]ana\s+)?a\s+las?\s+(\d{1,2})(?:[:.h](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|de\s+la\s+ma[ñn]ana|de\s+la\s+tarde|de\s+la\s+noche)?(\s+(?:de\s+)?ma[ñn]ana)?/i;

/** "mañana" suelto, sin hora: se toma a las 9. */
const TOMORROW_RE = /\bma[ñn]ana\b/i;

/**
 * Recordatorios que alguien se pide a sí mismo. La hora se entiende en
 * código (sin modelo): "en 2 horas", "a las 9", "mañana a las 21:30". Si no
 * se entiende, el pedido sigue al modelo como cualquier mensaje.
 */
@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);

  constructor(
    @InjectModel(Reminder.name) private readonly model: Model<ReminderDocument>,
    private readonly utils: UtilsService,
  ) {}

  /** ¿El mensaje pide un recordatorio? (sólo el verbo; la hora la ve `parse`). */
  static isReminderRequest(text: string): boolean {
    return INTENT_RE.test(text ?? '');
  }

  /**
   * Entiende "recordame <cuándo> que <qué>" y devuelve la hora y el texto, o
   * null si falta alguna de las dos. `botName` se saca del texto.
   */
  static parse(raw: string, now: Date, botName?: string): { dueAt: Date; text: string } | null {
    let text = (raw ?? '').trim();
    if (!INTENT_RE.test(text)) return null;

    let dueAt: Date | null = null;
    const rel = RELATIVE_RE.exec(text);
    const abs = rel ? null : ABSOLUTE_RE.exec(text);
    if (rel) {
      dueAt = new Date(now.getTime() + ReminderService.relativeMs(rel[1], rel[2]));
      text = text.replace(rel[0], ' ');
    } else if (abs) {
      dueAt = ReminderService.absoluteDate(now, abs);
      text = text.replace(abs[0], ' ');
    } else if (TOMORROW_RE.test(text)) {
      dueAt = ReminderService.localToUtc(now, 1, 9, 0);
      text = text.replace(TOMORROW_RE, ' ');
    }
    if (!dueAt) return null;

    text = text.replace(INTENT_RE, ' ');
    if (botName) {
      const esc = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`<@${esc}>|@?\\b${esc}\\b`, 'gi'), ' ');
    }
    text = text
      .replace(/<@[^>]+>/g, (m) => m.slice(2, -1))
      .replace(/^\s*[,.:;!¡¿?-]*\s*(?:bot\b)?/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:[,.:;-]\s*)*(?:que|de|para|a|lo\s+de)\s+/i, '')
      .replace(/^[,.:;-]\s*/, '')
      .replace(/[\s,.;:!¡¿?]+$/, '')
      .trim();
    if (!text) return null;
    return { dueAt, text };
  }

  private static relativeMs(amount: string, unit: string): number {
    const a = amount.toLowerCase();
    const n = a === 'un' || a === 'una' ? 1 : a === 'media' ? 0.5 : Number(a.replace(',', '.'));
    const u = unit.toLowerCase()[0];
    const base = u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : DAY_MS;
    return Math.round(n * base);
  }

  /** Fecha UTC para "hoy + `addDays`, a las `h`:`m`" en hora de El Salvador. */
  private static localToUtc(now: Date, addDays: number, h: number, m: number): Date {
    const local = new Date(now.getTime() - SV_OFFSET_MS);
    const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays, h, m);
    return new Date(target + SV_OFFSET_MS);
  }

  private static absoluteDate(now: Date, m: RegExpExecArray): Date | null {
    let hour = Number(m[2]);
    const minute = m[3] ? Number(m[3]) : 0;
    if (hour > 23 || minute > 59) return null;
    const marker = (m[4] ?? '').toLowerCase().replace(/[\s.]/g, '');
    const tomorrow = !!m[1] || !!m[5];
    const pm = marker === 'pm' || marker.includes('tarde') || marker.includes('noche');
    const am = marker === 'am' || marker.includes('manana') || marker.includes('mañana');
    if (pm && hour < 12) hour += 12;
    if (am && hour === 12) hour = 0;

    if (tomorrow) return ReminderService.localToUtc(now, 1, hour, minute);

    // Sin am/pm y con hora de 1 a 11: la próxima que venga (las 9 de la
    // mañana o las 21). Con marca o en formato 24 h: hoy, o mañana si ya pasó.
    const candidates: Date[] = [];
    for (const day of [0, 1]) {
      candidates.push(ReminderService.localToUtc(now, day, hour, minute));
      if (!pm && !am && hour >= 1 && hour < 12) candidates.push(ReminderService.localToUtc(now, day, hour + 12, minute));
    }
    return candidates.filter((d) => d.getTime() > now.getTime()).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  }

  /** "en 25 min", "hoy a las 21:30", "mañana a las 09:00" o "el 23/11 a las 10:00". */
  static describeWhen(dueAt: Date, now: Date): string {
    const diff = dueAt.getTime() - now.getTime();
    if (diff < 60 * 60_000) return `en ${Math.max(1, Math.round(diff / 60_000))} min`;
    const l = new Date(dueAt.getTime() - SV_OFFSET_MS);
    const n = new Date(now.getTime() - SV_OFFSET_MS);
    const hhmm = `${String(l.getUTCHours()).padStart(2, '0')}:${String(l.getUTCMinutes()).padStart(2, '0')}`;
    const dayDiff = Math.round(
      (Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) -
        Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())) /
        DAY_MS,
    );
    if (dayDiff === 0) return `hoy a las ${hhmm}`;
    if (dayDiff === 1) return `mañana a las ${hhmm}`;
    return `el ${l.getUTCDate()}/${l.getUTCMonth() + 1} a las ${hhmm}`;
  }

  async create(username: string, rawText: string, dueAt: Date, now = new Date()): Promise<CreateReminderResult> {
    const text = this.utils.sanitizeMemoryContent(rawText ?? '', { maxLen: MAX_REMINDER_TEXT, minLen: 1 });
    const userKey = (username ?? '').trim().toLowerCase();
    if (!text || !userKey) return 'invalid';
    const diff = dueAt.getTime() - now.getTime();
    if (diff < MIN_REMINDER_MS) return 'too_soon';
    if (diff > MAX_REMINDER_MS) return 'too_far';
    const pending = await this.model.countDocuments({ userKey, deliveredAt: null });
    if (pending >= MAX_PENDING_REMINDERS) return 'full';
    await this.model.create({
      userKey,
      username: username.trim(),
      text,
      dueAt,
      deliveredAt: null,
      expiresAt: new Date(dueAt.getTime() + 7 * DAY_MS),
    });
    return 'ok';
  }

  async listPending(username: string): Promise<PendingReminder[]> {
    const rows = await this.pendingQuery(username);
    return rows.map((r) => ({ text: r.text, dueAt: r.dueAt }));
  }

  /** Cancela el número `position` (1-based) de `listPending`. */
  async cancel(username: string, position: number): Promise<PendingReminder | null> {
    const rows = await this.pendingQuery(username);
    if (!Number.isInteger(position) || position < 1 || position > rows.length) return null;
    const target = rows[position - 1];
    const res = await this.model.deleteOne({ _id: target._id, deliveredAt: null }).exec();
    return res.deletedCount === 1 ? { text: target.text, dueAt: target.dueAt } : null;
  }

  private pendingQuery(username: string) {
    const userKey = (username ?? '').trim().toLowerCase();
    return this.model.find({ userKey, deliveredAt: null }).sort({ dueAt: 1, _id: 1 }).lean().exec();
  }

  /**
   * Reclama (marca entregados) los que ya vencieron, de a uno y en forma
   * atómica: si dos ticks se pisan, ninguno se manda dos veces.
   */
  async claimDue(now = new Date(), max = 20): Promise<Array<{ username: string; text: string; dueAt: Date }>> {
    const out: Array<{ username: string; text: string; dueAt: Date }> = [];
    try {
      for (let i = 0; i < max; i++) {
        const doc = await this.model
          .findOneAndUpdate(
            { deliveredAt: null, dueAt: { $lte: now } },
            { $set: { deliveredAt: now } },
            { sort: { dueAt: 1, _id: 1 }, returnDocument: 'after' },
          )
          .lean()
          .exec();
        if (!doc) break;
        out.push({ username: doc.username, text: doc.text, dueAt: doc.dueAt });
      }
    } catch (err) {
      this.logger.warn(`No se pudieron leer los recordatorios: ${(err as Error)?.message}`);
    }
    return out;
  }
}
