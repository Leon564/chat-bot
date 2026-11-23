import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createLog } from '../../common/utils/log';
import { UsageService } from '../chat/usage.service';
import { LOCAL_EMBEDDER, LocalEmbedder } from './local-embedder';

const log = createLog('EmbeddingService');

export type EmbedPurpose = 'query' | 'passage';
export type EmbeddingSource = 'external' | 'local' | 'keywords';

/** Tras un fallo del externo, no se lo vuelve a probar por este tiempo. */
export const EXTERNAL_RETRY_MS = 10 * 60_000;
const EXTERNAL_TIMEOUT_MS = 3000;

/** Similitud coseno; 0 si algún vector es nulo o las dimensiones no coinciden. */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Vectores de significado para la memoria. Externo (API compatible con
 * OpenAI) por defecto; si falla o no hay key, el modelo local. El modelo va
 * en el resultado (`ext:<modelo>` / `local:<modelo>`) porque los vectores de
 * modelos distintos no se pueden comparar entre sí.
 */
@Injectable()
export class EmbeddingService {
  /** Inyectable para tests. */
  now: () => number = Date.now;
  private client: Pick<OpenAI, 'embeddings'> | null = null;
  private externalDownUntil = 0;
  private lastSource: EmbeddingSource;

  constructor(
    private readonly configService: ConfigService,
    @Inject(LOCAL_EMBEDDER) private readonly local: LocalEmbedder,
    @Optional() private readonly usage?: UsageService,
  ) {
    this.lastSource = this.hasExternal() ? 'external' : 'local';
  }

  get externalModel(): string {
    return `ext:${this.configService.get<string>('memory.embeddings.model') || 'text-embedding-3-small'}`;
  }

  get localModel(): string {
    return `local:${this.local.model}`;
  }

  currentSource(): EmbeddingSource {
    return this.lastSource;
  }

  thresholdFor(model: string): number {
    return model.startsWith('ext:')
      ? this.configService.get<number>('memory.embeddings.thresholdExternal') ?? 0.45
      : this.configService.get<number>('memory.embeddings.thresholdLocal') ?? 0.86;
  }

  async embed(texts: string[], purpose: EmbedPurpose): Promise<{ model: string; vectors: number[][] } | null> {
    if (texts.length === 0) return { model: this.hasExternal() ? this.externalModel : this.localModel, vectors: [] };
    if (this.externalAvailable()) {
      const vectors = await this.tryExternal(texts);
      if (vectors) {
        this.lastSource = 'external';
        return { model: this.externalModel, vectors };
      }
    }
    const vectors = await this.tryLocal(texts, purpose);
    if (vectors) {
      this.lastSource = 'local';
      return { model: this.localModel, vectors };
    }
    this.lastSource = 'keywords';
    return null;
  }

  /** Vectores de un modelo concreto (para completar los que le faltan a un recuerdo). */
  async embedWith(model: string, texts: string[], purpose: EmbedPurpose): Promise<number[][] | null> {
    if (model === this.localModel) return this.tryLocal(texts, purpose);
    if (model === this.externalModel && this.externalAvailable()) return this.tryExternal(texts);
    return null;
  }

  private hasExternal(): boolean {
    return !!this.configService.get<string>('memory.embeddings.apiKey');
  }

  private externalAvailable(): boolean {
    return this.hasExternal() && this.now() >= this.externalDownUntil;
  }

  private async tryExternal(texts: string[]): Promise<number[][] | null> {
    const model = this.externalModel.slice('ext:'.length);
    const startedAt = this.now();
    try {
      this.client ??= new OpenAI({
        baseURL: this.configService.get<string>('memory.embeddings.baseUrl'),
        apiKey: this.configService.get<string>('memory.embeddings.apiKey'),
        timeout: EXTERNAL_TIMEOUT_MS,
        maxRetries: 0,
      });
      const res = await this.client.embeddings.create({ model, input: texts });
      void this.usage
        ?.record({
          kind: 'embedding',
          promptTokens: res.usage?.prompt_tokens ?? 0,
          completionTokens: 0,
          model,
          latencyMs: this.now() - startedAt,
        })
        .catch(() => {});
      return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (err) {
      this.externalDownUntil = this.now() + EXTERNAL_RETRY_MS;
      log.warn(`Embeddings externos fallaron, se usa el local por ${EXTERNAL_RETRY_MS / 60_000} min: ${(err as Error)?.message}`);
      return null;
    }
  }

  private async tryLocal(texts: string[], purpose: EmbedPurpose): Promise<number[][] | null> {
    try {
      // Los modelos e5 esperan el prefijo que dice si es consulta o pasaje.
      return await this.local.embed(texts.map((t) => `${purpose}: ${t}`));
    } catch (err) {
      log.warn(`El modelo local de embeddings falló: ${(err as Error)?.message}`);
      return null;
    }
  }
}
