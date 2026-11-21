import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import {
  rootMongooseTestModule,
  closeMongoConnection,
} from '../../common/testing/mongo-test.helper';
import { LlmUsage, LlmUsageSchema, LlmUsageDocument } from '../../common/schemas/llm-usage.schema';
import { UsageService, USAGE_CAP } from './usage.service';

describe('UsageService', () => {
  let connection: Connection;
  let service: UsageService;
  let model: Model<LlmUsageDocument>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([{ name: LlmUsage.name, schema: LlmUsageSchema }]),
      ],
      providers: [UsageService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    service = moduleRef.get<UsageService>(UsageService);
    model = moduleRef.get<Model<LlmUsageDocument>>(getModelToken(LlmUsage.name));
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await model.deleteMany({});
  });

  describe('summarize', () => {
    const seed = (user: string, prompt: number, completion: number, hoursAgo: number) =>
      model.collection.insertOne({
        kind: 'chat',
        user,
        promptTokens: prompt,
        completionTokens: completion,
        createdAt: new Date(Date.now() - hoursAgo * 3_600_000),
      });

    it('suma también los tokens servidos desde caché (filas viejas sin el campo cuentan 0)', async () => {
      await model.collection.insertOne({ kind: 'chat', user: 'a', promptTokens: 1000, completionTokens: 10, cachedPromptTokens: 900, createdAt: new Date() });
      await seed('b', 500, 5, 0); // sin cachedPromptTokens
      const s = await service.summarize(new Date(Date.now() - 3_600_000));
      expect(s.promptTokens).toBe(1500);
      expect(s.cachedPromptTokens).toBe(900);
    });

    it('suma la ventana pedida y ordena a los que más usan', async () => {
      await seed('nico', 100, 10, 1);
      await seed('nico', 200, 20, 2);
      await seed('kei', 50, 5, 3);
      await seed('', 1000, 100, 1); // sin usuario: cuenta en el total, no en el top
      await seed('viejo', 9999, 999, 48); // fuera de la ventana de 24 h

      const s = await service.summarize(new Date(Date.now() - 24 * 3_600_000));

      expect(s.calls).toBe(4);
      expect(s.promptTokens).toBe(1350);
      expect(s.completionTokens).toBe(135);
      expect(s.topUsers).toEqual([
        { user: 'nico', calls: 2, tokens: 330 },
        { user: 'kei', calls: 1, tokens: 55 },
      ]);
      expect(s.oldest?.getTime()).toBeLessThan(Date.now() - 47 * 3_600_000);
    });

    it('sin filas devuelve ceros', async () => {
      const s = await service.summarize(new Date(0));
      expect(s).toEqual({ calls: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, topUsers: [], oldest: null });
    });
  });

  it('persiste una fila con los campos dados', async () => {
    await service.record({
      kind: 'chat',
      user: 'Nico',
      promptTokens: 1800,
      completionTokens: 42,
      intents: ['PERSONA', 'ANILIST'],
      cacheHit: false,
    });

    const row = await model.findOne({}).lean().exec();
    expect(row!.kind).toBe('chat');
    expect(row!.user).toBe('Nico');
    expect(row!.promptTokens).toBe(1800);
    expect(row!.completionTokens).toBe(42);
    expect(row!.intents).toEqual(['PERSONA', 'ANILIST']);
    expect(row!.cacheHit).toBe(false);
  });

  it('aplica defaults cuando sólo se dan los campos obligatorios', async () => {
    await service.record({ kind: 'translate', promptTokens: 300, completionTokens: 250 });

    const row = await model.findOne({}).lean().exec();
    expect(row!.user).toBe('');
    expect(row!.intents).toEqual([]);
    expect(row!.cacheHit).toBe(false);
  });

  it('acepta un registro de cacheHit sin tokens', async () => {
    await service.record({ kind: 'translate', promptTokens: 0, completionTokens: 0, cacheHit: true });

    const row = await model.findOne({}).lean().exec();
    expect(row!.cacheHit).toBe(true);
    expect(row!.promptTokens).toBe(0);
  });

  it('no lanza cuando la escritura falla', async () => {
    const roto = jest.spyOn(model, 'create').mockRejectedValueOnce(new Error('mongo caído') as never);

    await expect(
      service.record({ kind: 'chat', promptTokens: 1, completionTokens: 1 }),
    ).resolves.toBeUndefined();

    roto.mockRestore();
  });

  it('poda las filas más viejas cuando se supera el tope', async () => {
    // El servicio sólo poda cuando el total excede el tope por un margen de
    // 500, para no escanear en cada escritura.
    const relleno = Array.from({ length: USAGE_CAP + 500 }, (_, i) => ({
      kind: 'chat',
      user: `u${i}`,
      promptTokens: i,
      completionTokens: 0,
      intents: [],
      cacheHit: false,
    }));
    await model.insertMany(relleno);

    await service.record({ kind: 'chat', promptTokens: 999999, completionTokens: 0 });

    const total = await model.countDocuments({});
    expect(total).toBeLessThanOrEqual(USAGE_CAP);

    // La fila recién escrita tiene que sobrevivir a la poda.
    const reciente = await model.findOne({ promptTokens: 999999 }).lean().exec();
    expect(reciente).not.toBeNull();
  });
});
