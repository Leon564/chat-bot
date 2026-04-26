import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MemoryDocument = Memory & Document;

/**
 * Each row is a single memory entry. The same shape covers both global and
 * per-user memories: when scope='user' the `user` field holds the owner,
 * when scope='global' it stays null. Switching from the legacy
 * { global: [...], users: { [name]: [...] } } JSON to a flat collection
 * makes querying and per-user/global capping trivial.
 */
@Schema({ timestamps: true, collection: 'memories' })
export class Memory {
  @Prop({ required: true, enum: ['global', 'user'], index: true })
  scope: 'global' | 'user';

  @Prop({ default: null, index: true })
  user: string | null;

  @Prop({ required: true })
  content: string;
}

export const MemorySchema = SchemaFactory.createForClass(Memory);
MemorySchema.index({ scope: 1, user: 1, createdAt: -1 });
