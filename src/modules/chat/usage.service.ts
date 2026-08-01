import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LlmUsage, LlmUsageDocument, LlmKind } from '../../common/schemas/llm-usage.schema';

export interface RecordUsageInput {
  kind: LlmKind;
  user?: string;
  promptTokens: number;
  completionTokens: number;
  intents?: string[];
  cacheHit?: boolean;
}

/** Filas que se conservan. */
export const USAGE_CAP = 5000;

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

  constructor(
    @InjectModel(LlmUsage.name) private readonly usageModel: Model<LlmUsageDocument>,
  ) {}

  async record(input: RecordUsageInput): Promise<void> {
    try {
      await this.usageModel.create({
        kind: input.kind,
        user: input.user ?? '',
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        intents: input.intents ?? [],
        cacheHit: input.cacheHit ?? false,
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
}
