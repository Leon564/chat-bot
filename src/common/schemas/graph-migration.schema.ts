import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GraphMigrationDocument = GraphMigration & Document;

/**
 * Centinela de migraciones del grafo. MigrationService se guarda renombrando
 * el archivo fuente a .bak, pero acá la fuente es una colección de Mongo y no
 * hay nada que renombrar — el centinela va en base de datos. El chequeo
 * `findOne` + `create` en GraphMigrationService.run() NO es atómico por sí
 * mismo; con un solo proceso (el caso real hoy) eso es inofensivo. El índice
 * único sobre `name` sólo convierte una carrera entre procesos concurrentes
 * en un E11000 en el `create` perdedor, que `onModuleInit` atrapa y loguea —
 * no la evita. Los upsert de `upsertNode`/`upsertEdge` hacen el resultado
 * idempotente de todas formas, así que una corrida duplicada no corrompe el
 * grafo aunque el centinela no fuera perfecto.
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
