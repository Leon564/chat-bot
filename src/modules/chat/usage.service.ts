import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LlmUsage, LlmKind } from '../../common/schemas/llm-usage.schema';

export interface RecordUsageInput {
  kind: LlmKind;
  user?: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  model?: string;
  intents?: string[];
  cacheHit?: boolean;
  latencyMs?: number;
}

/** Filas que se conservan. */
export const USAGE_CAP = 5000;

export interface UsageSummary {
  calls: number;
  promptTokens: number;
  /** Parte de `promptTokens` que el proveedor sirvió desde su caché. */
  cachedPromptTokens: number;
  completionTokens: number;
  /** Los que más llamadas dispararon en la ventana (sin filas sin usuario). */
  topUsers: Array<{ user: string; calls: number; tokens: number }>;
  /** Fila más vieja que queda en la colección (por el tope, puede ser más nueva que `since`). */
  oldest: Date | null;
  /** Tiempos de respuesta de las respuestas de charla (kind 'chat'), o null sin datos. */
  latency: { p50: number; p95: number; max: number; samples: number } | null;
}

/** Percentil `p` (0..1) de una lista YA ordenada, por el método del rango más cercano. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Margen antes de podar: escanear en cada escritura sería caro y la colección
 * crece de a una fila por llamada. Mismo patrón que LoggingService.
 */
const PRUNE_MARGIN = 500;

/**
 * Registra el consumo de tokens de cada llamada al modelo.
 *
 * Es best-effort por diseño: medir no puede degradar ni romper una respuesta,
 * así que toda excepción se traga acá. Los llamadores además invocan esto sin
 * esperarlo.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  /**
   * Va `Model<LlmUsage>` y NO `Model<LlmUsageDocument>` a proposito. El campo
   * `model` de esta coleccion choca con el metodo `model()` que trae
   * `mongoose.Document`, asi que en la interseccion `LlmUsage & Document` ese
   * campo queda tipado `string & (funcion)` y `create()` rechaza un string
   * pelado. Con el tipo crudo el documento hidratado sigue siendo el mismo en
   * runtime y el create vuelve a tipar contra los campos del schema.
   */
  constructor(
    @InjectModel(LlmUsage.name) private readonly usageModel: Model<LlmUsage>,
  ) {}

  async record(input: RecordUsageInput): Promise<void> {
    try {
      await this.usageModel.create({
        kind: input.kind,
        user: input.user ?? '',
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        cachedPromptTokens: input.cachedPromptTokens ?? 0,
        model: input.model ?? '',
        intents: input.intents ?? [],
        cacheHit: input.cacheHit ?? false,
        latencyMs: input.latencyMs && input.latencyMs > 0 ? Math.round(input.latencyMs) : 0,
      });

      const total = await this.usageModel.estimatedDocumentCount();
      if (total > USAGE_CAP + PRUNE_MARGIN) {
        const overflow = await this.usageModel
          .find()
          .sort({ createdAt: -1 })
          .skip(USAGE_CAP)
          .select({ _id: 1 })
          .lean()
          .exec();

        if (overflow.length > 0) {
          await this.usageModel.deleteMany({ _id: { $in: overflow.map((d) => d._id) } });
        }
      }
    } catch (err) {
      this.logger.warn(`No se pudo registrar el uso de tokens: ${(err as Error)?.message}`);
    }
  }

  /**
   * Totales desde `since`, para `!uso`. La colección guarda sólo las últimas
   * `USAGE_CAP` filas, así que `oldest` le dice al llamador si la ventana pedida
   * quedó recortada.
   */
  async summarize(since: Date, topN = 5): Promise<UsageSummary> {
    const match = { createdAt: { $gte: since } };
    const [totals, top, oldestRow, latencyRows] = await Promise.all([
      this.usageModel
        .aggregate<{ calls: number; promptTokens: number; cachedPromptTokens: number; completionTokens: number }>([
          { $match: match },
          {
            $group: {
              _id: null,
              calls: { $sum: 1 },
              promptTokens: { $sum: '$promptTokens' },
              cachedPromptTokens: { $sum: { $ifNull: ['$cachedPromptTokens', 0] } },
              completionTokens: { $sum: '$completionTokens' },
            },
          },
        ])
        .exec(),
      this.usageModel
        .aggregate<{ _id: string; calls: number; tokens: number }>([
          { $match: { ...match, user: { $ne: '' } } },
          {
            $group: {
              _id: '$user',
              calls: { $sum: 1 },
              tokens: { $sum: { $add: ['$promptTokens', '$completionTokens'] } },
            },
          },
          { $sort: { calls: -1, tokens: -1 } },
          { $limit: topN },
        ])
        .exec(),
      this.usageModel.findOne().sort({ createdAt: 1 }).select({ createdAt: 1 }).lean().exec(),
      // Percentiles en JS (la colección se poda a USAGE_CAP filas): `$percentile`
      // pide MongoDB 7 y el de los tests puede ser más viejo.
      this.usageModel
        .find({ ...match, kind: 'chat', latencyMs: { $gt: 0 } })
        .select({ latencyMs: 1 })
        .lean()
        .exec(),
    ]);
    const latencies = (latencyRows as Array<{ latencyMs?: number }>)
      .map((r) => r.latencyMs ?? 0)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);

    const t = totals[0];
    return {
      calls: t?.calls ?? 0,
      promptTokens: t?.promptTokens ?? 0,
      cachedPromptTokens: t?.cachedPromptTokens ?? 0,
      completionTokens: t?.completionTokens ?? 0,
      topUsers: top.map((r) => ({ user: r._id, calls: r.calls, tokens: r.tokens })),
      oldest: (oldestRow as { createdAt?: Date } | null)?.createdAt ?? null,
      latency:
        latencies.length > 0
          ? {
              p50: percentile(latencies, 0.5),
              p95: percentile(latencies, 0.95),
              max: latencies[latencies.length - 1],
              samples: latencies.length,
            }
          : null,
    };
  }
}
