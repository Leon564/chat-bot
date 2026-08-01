import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ContextDocument = Context & Document;

/** A historical Q/A pair the bot replays back to the LLM as context. */
@Schema({ timestamps: true, collection: 'context' })
export class Context {
  @Prop({ required: true })
  question: string;

  @Prop({ required: true })
  answer: string;

  @Prop({ default: '' })
  user: string;

  /**
   * Lo aporta `timestamps: true`, no un @Prop. Se declara sólo para que
   * FilterQuery lo acepte en las consultas por antigüedad.
   */
  createdAt?: Date;
}

export const ContextSchema = SchemaFactory.createForClass(Context);
ContextSchema.index({ user: 1, createdAt: -1 });
