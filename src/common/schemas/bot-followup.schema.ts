import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BotFollowupDocument = BotFollowup & Document;

/**
 * Seguimiento de un recuerdo de tipo evento: `before` (suerte el día del
 * evento, con mención) o `after` ("¿cómo te fue?" cuando la persona aparece).
 * Separado de `bot_reminders` para que no salga en `!recordatorios`.
 */
@Schema({ timestamps: true, collection: 'bot_followups' })
export class BotFollowup {
  @Prop({ required: true })
  userKey: string;

  @Prop({ required: true })
  username: string;

  @Prop({ type: Types.ObjectId, required: true })
  memoryId: Types.ObjectId;

  @Prop({ required: true, enum: ['before', 'after'] })
  phase: 'before' | 'after';

  /** `before`: cuándo sale. `after`: desde cuándo está disponible. */
  @Prop({ required: true })
  dueAt: Date;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ default: 'pending', enum: ['pending', 'sent', 'skipped'] })
  status: 'pending' | 'sent' | 'skipped';

  @Prop({ type: Date, default: null })
  sentAt: Date | null;
}

export const BotFollowupSchema = SchemaFactory.createForClass(BotFollowup);
BotFollowupSchema.index({ status: 1, phase: 1, dueAt: 1 });
BotFollowupSchema.index({ userKey: 1, status: 1 });
BotFollowupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
