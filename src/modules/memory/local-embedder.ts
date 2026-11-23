import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLog } from '../../common/utils/log';

const log = createLog('LocalEmbedder');

/** Modelo de embeddings que corre dentro del proceso (respaldo del externo). */
export interface LocalEmbedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export const LOCAL_EMBEDDER = Symbol('LOCAL_EMBEDDER');

type FeatureExtractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

/**
 * `@huggingface/transformers` cargado recién en el primer `embed`: mientras el
 * externo funcione, el modelo (~120 MB en disco, ~200 MB de RAM) no se baja ni
 * se carga. Si la librería nativa no funciona en el servidor, `embed` lanza y
 * `EmbeddingService` cae al piso de palabras clave.
 */
@Injectable()
export class TransformersLocalEmbedder implements LocalEmbedder {
  readonly model: string;
  private extractor: Promise<FeatureExtractor> | null = null;

  constructor(configService: ConfigService) {
    this.model = configService.get<string>('memory.embeddings.localModel') || 'Xenova/multilingual-e5-small';
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.extractor ??= this.load();
    try {
      const extractor = await this.extractor;
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      return output.tolist();
    } catch (err) {
      // Permite reintentar la carga más adelante (p. ej. si falló la descarga).
      this.extractor = null;
      throw err;
    }
  }

  private async load(): Promise<FeatureExtractor> {
    log.info(`🧠 Cargando el modelo local de embeddings (${this.model})…`);
    const { pipeline } = await import('@huggingface/transformers');
    const extractor = (await pipeline('feature-extraction', this.model)) as unknown as FeatureExtractor;
    log.info('🧠 Modelo local listo');
    return extractor;
  }
}
