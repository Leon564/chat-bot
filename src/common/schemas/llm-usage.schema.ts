import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LlmUsageDocument = LlmUsage & Document;

/** Qué llamada al modelo produjo esta fila. */
export type LlmKind = 'chat' | 'translate' | 'summary';

export const LLM_KINDS: LlmKind[] = ['chat', 'translate', 'summary'];

/**
 * Una llamada al modelo, con su consumo real de tokens.
 *
 * Existe para tener línea base medida antes de tocar el prompt en la fase 3:
 * el ahorro se compara contra estos números en vez de asumirse. `intents`
 * queda vacío hasta que exista el router; `cacheHit` hasta que la fase 4
 * pueda evitar llamadas.
 *
 * No se reutiliza `events_log` porque su campo `user` es `required: true` sin
 * default —una traducción no tiene usuario— y no tiene campos numéricos.
 */
@Schema({ timestamps: true, collection: 'bot_llm_usage' })
export class LlmUsage {
  @Prop({ required: true, enum: LLM_KINDS, index: true })
  kind: LlmKind;

  @Prop({ default: '' })
  user: string;

  @Prop({ required: true, default: 0 })
  promptTokens: number;

  @Prop({ required: true, default: 0 })
  completionTokens: number;

  /** Bloques que el router incluyó. Vacío hasta la fase 3. */
  @Prop({ type: [String], default: [] })
  intents: string[];

  /** True cuando se evitó la llamada. Siempre false hasta la fase 4. */
  @Prop({ default: false })
  cacheHit: boolean;

  /**
   * Lo aporta `timestamps: true`. Se declara sólo para el tipado de las
   * consultas de poda.
   */
  createdAt?: Date;
}

export const LlmUsageSchema = SchemaFactory.createForClass(LlmUsage);
LlmUsageSchema.index({ createdAt: -1 });
LlmUsageSchema.index({ kind: 1, createdAt: -1 });
