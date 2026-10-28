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

/**
 * TTL: las filas de más de 30 minutos ya no se leen (ver MAX_AGE_MINUTES en
 * context.service.ts), pero sin este índice tampoco se borraban nunca — cada
 * username que pasó alguna vez deja 4 filas permanentes. Este número tiene
 * que seguir a MAX_AGE_MINUTES si ese valor cambia; no se importa la
 * constante acá para no crear una dependencia de un schema hacia un servicio.
 */
ContextSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 60 });
