import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ErrandDocument = Errand & Document;

/**
 * Un recado diferido: "cuando Lyna te hable, recordale X".
 *
 * Colección propia y no una arista del grafo a propósito: una arista es
 * BINARIA (`from`, `to`) y un recado es ternario — de quién, para quién, qué
 * — más caducidad y estado de entrega. `GraphEdge` no tiene dónde meter eso
 * sin deformarlo.
 *
 * `fromUser`/`forUser` se guardan normalizados con
 * `GraphService.normalizeUserKey` (minúsculas, acentos y espacios internos
 * intactos) para poder consultarlos por igualdad. `fromLabel` guarda el
 * nombre tal como se muestra, que es el que va en el mensaje entregado.
 */
@Schema({ timestamps: true, collection: 'bot_errands' })
export class Errand {
  @Prop({ required: true })
  fromUser: string;

  @Prop({ required: true })
  fromLabel: string;

  @Prop({ required: true })
  forUser: string;

  @Prop({ required: true })
  text: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: Date, default: null })
  deliveredAt: Date | null;
}

export const ErrandSchema = SchemaFactory.createForClass(Errand);
// La consulta de entrega: pendientes para alguien, no vencidos, más viejo primero.
ErrandSchema.index({ forUser: 1, deliveredAt: 1, expiresAt: 1, createdAt: 1 });
// El tope por autor.
ErrandSchema.index({ fromUser: 1, deliveredAt: 1 });
