import { ConfigService } from '@nestjs/config';
import { EmbeddingService, cosine } from './embedding.service';
import { LocalEmbedder } from './local-embedder';

jest.mock('../../common/utils/log', () => ({
  createLog: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

function build(opts: { apiKey?: string } = {}) {
  const values: Record<string, unknown> = {
    'memory.embeddings.baseUrl': 'https://api.example.com/v1',
    'memory.embeddings.model': 'text-embedding-3-small',
    'memory.embeddings.apiKey': opts.apiKey ?? 'clave',
    'memory.embeddings.localModel': 'Xenova/multilingual-e5-small',
    'memory.embeddings.thresholdExternal': 0.45,
    'memory.embeddings.thresholdLocal': 0.82,
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  const local: LocalEmbedder & { embed: jest.Mock } = {
    model: 'Xenova/multilingual-e5-small',
    embed: jest.fn(async (texts: string[]) => texts.map(() => [0, 1])),
  };
  const usage = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new EmbeddingService(config, local, usage as any);
  const create = jest.fn(async ({ input }: { input: string[] }) => ({
    data: input.map((_, i) => ({ index: i, embedding: [1, 0] })),
    usage: { prompt_tokens: 7 },
  }));
  (service as any).client = { embeddings: { create } };
  let now = 1_000_000;
  service.now = () => now;
  return { service, local, create, usage, advance: (ms: number) => (now += ms) };
}

describe('EmbeddingService', () => {
  it('con key y externo OK usa el externo y no carga el local', async () => {
    const { service, local, create, usage } = build();
    const out = await service.embed(['hola'], 'query');
    expect(out).toEqual({ model: 'ext:text-embedding-3-small', vectors: [[1, 0]] });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'text-embedding-3-small', input: ['hola'] }));
    expect(local.embed).not.toHaveBeenCalled();
    expect(service.currentSource()).toBe('external');
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'embedding', promptTokens: 7, completionTokens: 0, model: 'text-embedding-3-small' }),
    );
  });

  it('sin key va directo al local, con los prefijos de e5', async () => {
    const { service, local, create } = build({ apiKey: '' });
    const out = await service.embed(['hola', 'che'], 'passage');
    expect(out?.model).toBe('local:Xenova/multilingual-e5-small');
    expect(local.embed).toHaveBeenCalledWith(['passage: hola', 'passage: che']);
    expect(create).not.toHaveBeenCalled();
    await service.embed(['hola'], 'query');
    expect(local.embed).toHaveBeenLastCalledWith(['query: hola']);
    expect(service.currentSource()).toBe('local');
  });

  it('si el externo falla usa el local y no lo reintenta por 10 min', async () => {
    const { service, local, create, advance } = build();
    create.mockRejectedValueOnce(new Error('402 sin crédito'));
    expect((await service.embed(['a'], 'query'))?.model).toBe('local:Xenova/multilingual-e5-small');
    expect(create).toHaveBeenCalledTimes(1);

    advance(9 * 60_000);
    await service.embed(['b'], 'query');
    expect(create).toHaveBeenCalledTimes(1);
    expect(local.embed).toHaveBeenCalledTimes(2);

    advance(2 * 60_000);
    expect((await service.embed(['c'], 'query'))?.model).toBe('ext:text-embedding-3-small');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('si fallan los dos devuelve null y la fuente queda en palabras clave', async () => {
    const { service, local, create } = build();
    create.mockRejectedValue(new Error('caído'));
    local.embed.mockRejectedValue(new Error('onnxruntime no carga'));
    expect(await service.embed(['a'], 'query')).toBeNull();
    expect(service.currentSource()).toBe('keywords');
  });

  it('embedWith fuerza el modelo pedido', async () => {
    const { service, local, create } = build();
    expect(await service.embedWith('local:Xenova/multilingual-e5-small', ['a'], 'passage')).toEqual([[0, 1]]);
    expect(create).not.toHaveBeenCalled();
    expect(await service.embedWith('ext:text-embedding-3-small', ['a'], 'passage')).toEqual([[1, 0]]);
    expect(local.embed).toHaveBeenCalledTimes(1);
    expect(await service.embedWith('ext:otro-modelo', ['a'], 'passage')).toBeNull();
  });

  it('embedWith al externo durante la pausa devuelve null sin llamar', async () => {
    const { service, create } = build();
    create.mockRejectedValueOnce(new Error('caído'));
    await service.embed(['a'], 'query');
    expect(await service.embedWith('ext:text-embedding-3-small', ['a'], 'passage')).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('thresholdFor según el modelo', () => {
    const { service } = build();
    expect(service.thresholdFor('ext:text-embedding-3-small')).toBe(0.45);
    expect(service.thresholdFor('local:Xenova/multilingual-e5-small')).toBe(0.82);
  });

  it('lista vacía no llama a nadie', async () => {
    const { service, local, create } = build();
    expect(await service.embed([], 'query')).toEqual({ model: 'ext:text-embedding-3-small', vectors: [] });
    expect(create).not.toHaveBeenCalled();
    expect(local.embed).not.toHaveBeenCalled();
  });
});

describe('cosine', () => {
  it('casos básicos', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 1], [2, 2])).toBeCloseTo(1);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });
});
