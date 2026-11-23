import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { MEMORY_KINDS, MemoryKind } from '../../modules/memory/memory.types';

export type BotMemoryDocument = BotMemory & Document & { createdAt: Date; updatedAt: Date };

/**
 * Recuerdo a largo plazo de un usuario registrado, que Aria decidió guardar
 * sola (verbo `RECUERDO`). Ver docs/superpowers/specs/2026-11-22-memoria-largo-plazo-design.md.
 */
@Schema({ timestamps: true, collection: 'bot_memories' })
export class BotMemory {
  /** Clave normalizada (trim + minúsculas, la misma regla que el grafo). */
  @Prop({ required: true })
  userKey: string;

  /** Nombre tal como se escribió, para menciones. */
  @Prop({ required: true })
  username: string;

  @Prop({ required: true, enum: MEMORY_KINDS })
  kind: MemoryKind;

  @Prop({ required: true })
  text: string;

  @Prop({ type: [String], default: [] })
  keywords: string[];

  @Prop({ type: String, default: null })
  eventDate?: string | null;

  @Prop({ type: String, default: null })
  eventTime?: string | null;

  @Prop({ default: false })
  sensitive: boolean;

  /** Un vector por modelo (`ext:<modelo>` / `local:<modelo>`); nunca se comparan entre modelos. */
  @Prop({ type: [{ _id: false, model: String, vector: [Number] }], default: [] })
  embeddings: { model: string; vector: number[] }[];

  @Prop({ default: 'active', enum: ['active', 'done', 'cancelled'] })
  status: 'active' | 'done' | 'cancelled';

  @Prop({ default: 0 })
  useCount: number;

  @Prop({ type: Date, default: null })
  lastUsedAt: Date | null;
}

export const BotMemorySchema = SchemaFactory.createForClass(BotMemory);
BotMemorySchema.index({ userKey: 1, status: 1 });
