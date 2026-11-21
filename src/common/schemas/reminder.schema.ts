import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ReminderDocument = Reminder & Document;

/**
 * Recordatorio que alguien se pidió a sí mismo ("bot recordame en 2h que…",
 * `!recordar 30m …`). Vive en Mongo para sobrevivir reinicios; al entregarse
 * se marca `deliveredAt` y el índice TTL lo borra una semana después.
 */
@Schema({ timestamps: true, collection: 'bot_reminders' })
export class Reminder {
  /** Clave normalizada (minúsculas) para buscar. */
  @Prop({ required: true })
  userKey: string;

  /** Nombre tal como lo escribió, para la mención. */
  @Prop({ required: true })
  username: string;

  @Prop({ required: true })
  text: string;

  @Prop({ required: true })
  dueAt: Date;

  @Prop({ type: Date, default: null })
  deliveredAt: Date | null;

  /** Para el TTL: `dueAt` + 7 días. */
  @Prop({ required: true })
  expiresAt: Date;
}

export const ReminderSchema = SchemaFactory.createForClass(Reminder);
ReminderSchema.index({ deliveredAt: 1, dueAt: 1 });
ReminderSchema.index({ userKey: 1, deliveredAt: 1, dueAt: 1 });
ReminderSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
