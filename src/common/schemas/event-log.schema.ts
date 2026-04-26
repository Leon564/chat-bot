import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EventLogDocument = EventLog & Document;

@Schema({ timestamps: true, collection: 'events_log' })
export class EventLog {
  @Prop({ required: true, index: true })
  event: string;

  @Prop({ required: true })
  user: string;

  // Kept for compatibility with the legacy JSON which stored a date string;
  // new rows can rely on createdAt but we keep `date` so getLastEventType()
  // behaves identically.
  @Prop({ required: true, default: () => new Date() })
  date: Date;
}

export const EventLogSchema = SchemaFactory.createForClass(EventLog);
EventLogSchema.index({ event: 1, date: -1 });
