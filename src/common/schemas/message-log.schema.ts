import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MessageLogDocument = MessageLog & Document;

@Schema({ timestamps: true, collection: 'messages_log' })
export class MessageLog {
  @Prop({ required: true, index: true })
  user: string;

  @Prop({ required: true })
  message: string;
}

export const MessageLogSchema = SchemaFactory.createForClass(MessageLog);
MessageLogSchema.index({ createdAt: -1 });
