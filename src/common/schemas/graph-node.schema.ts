import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GraphNodeDocument = GraphNode & Document;

/**
 * Tipos de entidad del grafo. Cerrado a propósito: el objeto de un hecho
 * emitido por el modelo tiene que resolver contra uno de estos, así que un
 * usuario no puede plantar texto arbitrario como entidad.
 */
export type NodeType = 'user' | 'work' | 'genre' | 'track' | 'artist' | 'topic';

export const NODE_TYPES: NodeType[] = ['user', 'work', 'genre', 'track', 'artist', 'topic'];

/**
 * `props.lastNode` de un nodo `user`: la última entidad (work/track/…) que
 * esa persona consultó, para que `GraphContextService` pueda resolver
 * referencias ambiguas del turno siguiente ("¿y el segundo tomo?"). `key` y
 * `type` son la identidad real del nodo (no el label), igual que `TopEdge.key`
 * en `graph.service.ts`. Lo escriben `GraphIngestService.ingestAniList` e
 * `ingestTrack` — nunca `ingestSocial` (ver comentario ahí: una mención no es
 * "lo último que miró").
 */
export interface LastNodeProp {
  key: string;
  type: NodeType;
  label: string;
  at: Date;
}

/**
 * Un nodo del grafo de conocimiento. `key` es la identidad normalizada y es
 * única por tipo — 'anilist:105398' para obras, el username normalizado para
 * usuarios. `label` es el nombre para mostrar y puede cambiar; `key` no.
 *
 * `aliases` es la tabla que resuelve "el manhwa de la torre" a Tower of God
 * sin gastar una llamada al modelo, y además alimenta la detección de
 * intención del router (fase 3).
 */
@Schema({ timestamps: true, collection: 'bot_nodes' })
export class GraphNode {
  @Prop({ required: true, enum: NODE_TYPES, index: true })
  type: NodeType;

  @Prop({ required: true })
  key: string;

  @Prop({ required: true })
  label: string;

  @Prop({ type: [String], default: [] })
  aliases: string[];

  @Prop({ type: Object, default: {} })
  props: Record<string, unknown>;

  @Prop({ default: 0 })
  weight: number;

  @Prop({ default: () => new Date() })
  lastSeenAt: Date;
}

export const GraphNodeSchema = SchemaFactory.createForClass(GraphNode);
GraphNodeSchema.index({ type: 1, key: 1 }, { unique: true });
GraphNodeSchema.index({ aliases: 1 });
GraphNodeSchema.index({ type: 1, weight: -1 });
