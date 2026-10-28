import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type GraphEdgeDocument = GraphEdge & Document;

/**
 * Relaciones posibles. El enum es cerrado y validado por Mongoose: es la
 * defensa principal contra inyección por memoria. Con texto libre (el sistema
 * anterior) había que sanitizar strings; acá una relación inventada
 * simplemente no valida.
 */
export type EdgeType =
  | 'likes'
  | 'dislikes'
  | 'asked_about'
  | 'recommended_to'
  | 'requested'
  | 'has_genre'
  | 'by_artist'
  | 'interacts_with';

export const EDGE_TYPES: EdgeType[] = [
  'likes',
  'dislikes',
  'asked_about',
  'recommended_to',
  'requested',
  'has_genre',
  'by_artist',
  'interacts_with',
];

/** De dónde salió la arista, para poder purgar lo de menor confianza. */
export type EdgeSource = 'signal' | 'fact' | 'batch';

export const EDGE_SOURCES: EdgeSource[] = ['signal', 'fact', 'batch'];

/**
 * Una arista dirigida. El índice único sobre {from, to, type} es la pieza
 * central del diseño: escribir una relación es un upsert con $inc, así que
 * repetir un hecho sube la confianza en vez de crear un duplicado. Eso
 * reemplaza la deduplicación por similitud de strings del sistema anterior.
 *
 * `weight` arranca en 0 y el upsert lo lleva a 1 en la primera escritura —
 * un default de 1 chocaría con el $inc.
 */
@Schema({ timestamps: true, collection: 'bot_edges' })
export class GraphEdge {
  @Prop({ type: Types.ObjectId, ref: 'GraphNode', required: true })
  from: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'GraphNode', required: true })
  to: Types.ObjectId;

  @Prop({ required: true, enum: EDGE_TYPES })
  type: EdgeType;

  @Prop({ default: 0 })
  weight: number;

  @Prop({ required: true, enum: EDGE_SOURCES })
  source: EdgeSource;

  @Prop({ default: () => new Date() })
  lastSeenAt: Date;
}

export const GraphEdgeSchema = SchemaFactory.createForClass(GraphEdge);
GraphEdgeSchema.index({ from: 1, to: 1, type: 1 }, { unique: true });
GraphEdgeSchema.index({ from: 1, type: 1, weight: -1 });
GraphEdgeSchema.index({ to: 1, type: 1, weight: -1 });
