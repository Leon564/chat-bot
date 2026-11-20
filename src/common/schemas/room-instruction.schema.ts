import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RoomInstructionDocument = RoomInstruction & Document;

/**
 * Una instrucción permanente para toda la sala ("respondé a todos con texto de
 * colores"). Vive aparte del historial (`context`) a propósito: el historial
 * es una ventana corta que se poda por usuario y vence a los 30 minutos, así
 * que una orden dada ahí se perdía a los pocos mensajes. Éstas entran al
 * system prompt de cada respuesta hasta que un admin las quite.
 */
@Schema({ timestamps: true, collection: 'bot_room_instructions' })
export class RoomInstruction {
  @Prop({ required: true })
  text: string;

  /** Nombre (tal como se muestra) de quien la dio. */
  @Prop({ required: true })
  createdBy: string;

  /** `command` = `!instruccion …`; `model` = la detectó el modelo (SAVE_INSTRUCTION). */
  @Prop({ required: true, enum: ['command', 'model'] })
  source: 'command' | 'model';

  /** `null` = hasta que la quiten. Con fecha, deja de aplicar sola al vencer. */
  @Prop({ type: Date, default: null })
  expiresAt: Date | null;

  createdAt?: Date;
}

export const RoomInstructionSchema = SchemaFactory.createForClass(RoomInstruction);
RoomInstructionSchema.index({ createdAt: 1 });
// TTL: Mongo borra las vencidas (las que tienen `expiresAt: null` no se tocan).
// El servicio igual las filtra al leer, porque el barrido de Mongo corre cada
// ~60 s y no puede quedar una instrucción vencida aplicándose hasta entonces.
RoomInstructionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
