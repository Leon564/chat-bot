import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GraphMigrationDocument = GraphMigration & Document;

/**
 * Centinela de migraciones del grafo. MigrationService se guarda renombrando
 * el archivo fuente a .bak, pero acá la fuente es una colección de Mongo y no
 * hay nada que renombrar — el centinela va en base de datos. El índice único
 * sobre `name` es lo que hace la guarda atómica.
 */
@Schema({ timestamps: true, collection: 'bot_migrations' })
export class GraphMigration {
  @Prop({ required: true })
  name: string;

  @Prop({ type: Object, default: {} })
  stats: Record<string, unknown>;
}

export const GraphMigrationSchema = SchemaFactory.createForClass(GraphMigration);
GraphMigrationSchema.index({ name: 1 }, { unique: true });
