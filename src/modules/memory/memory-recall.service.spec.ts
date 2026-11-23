import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { rootMongooseTestModule, closeMongoConnection } from '../../common/testing/mongo-test.helper';
import { BotMemory, BotMemoryDocument, BotMemorySchema } from '../../common/schemas/bot-memory.schema';
import { MemoryStore } from './memory-store.service';
import { EmbeddingService } from './embedding.service';
import { MemoryRecallService, MAX_RECALLED, REPEAT_WINDOW_MS } from './memory-recall.service';

// Viernes 2026-11-27 es "pasado mañana +3"; hoy es domingo 2026-11-22, 10:00 local.
const NOW = new Date('2026-11-22T16:00:00Z');
const EXT = 'ext:test';
const THRESHOLD = 0.5;

describe('MemoryRecallService', () => {
  let recall: MemoryRecallService;
  let model: Model<BotMemoryDocument>;
  let connection: Connection;
  /** Vector que devuelve el "modelo" para cada texto; lo que no está, ortogonal a todo. */
  let vectors: Record<string, number[]>;
  let embeddings: { embed: jest.Mock; embedWith: jest.Mock; thresholdFor: jest.Mock };

  const vecFor = (t: string) => vectors[t.replace(/^(query|passage): /, '')] ?? [0, 0, 1];

  beforeAll(async () => {
    embeddings = {
      embed: jest.fn(async (texts: string[]) => ({ model: EXT, vectors: texts.map(vecFor) })),
      embedWith: jest.fn(async (_m: string, texts: string[]) => texts.map(vecFor)),
      thresholdFor: jest.fn(() => THRESHOLD),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [rootMongooseTestModule(), MongooseModule.forFeature([{ name: BotMemory.name, schema: BotMemorySchema }])],
      providers: [MemoryStore, MemoryRecallService, { provide: EmbeddingService, useValue: embeddings }],
    }).compile();
    recall = moduleRef.get(MemoryRecallService);
    model = moduleRef.get(getModelToken(BotMemory.name));
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await model.deleteMany({});
    recall.resetShown();
    vectors = {};
    embeddings.embed.mockClear();
    embeddings.embedWith.mockClear();
    embeddings.embed.mockImplementation(async (texts: string[]) => ({ model: EXT, vectors: texts.map(vecFor) }));
  });

  const insert = (over: Partial<BotMemory>) =>
    model.create({ userKey: 'victoria', username: 'Victoria', kind: 'fact', keywords: [], sensitive: false, status: 'active', text: 'x', ...over });

  it('sin recuerdos devuelve bloque vacío y no calcula vectores', async () => {
    const out = await recall.recall('Victoria', 'hola', NOW);
    expect(out.block).toBe('');
    expect(out.refs.size).toBe(0);
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it('un evento de los próximos 3 días entra aunque el mensaje no se le parezca', async () => {
    await insert({ kind: 'event', text: 'Rinde el examen de cálculo', eventDate: '2026-11-25' });
    vectors['hola'] = [1, 0, 0];
    vectors['Rinde el examen de cálculo'] = [0, 1, 0];
    const out = await recall.recall('Victoria', 'hola', NOW);
    expect(out.block).toContain('Rinde el examen de cálculo');
    expect(out.refs.size).toBe(1);
  });

  it('un evento de dentro de 5 días no entra si no se parece', async () => {
    await insert({ kind: 'event', text: 'viaja a la playa', eventDate: '2026-11-27' });
    vectors['hola'] = [1, 0, 0];
    vectors['viaja a la playa'] = [0, 1, 0];
    expect((await recall.recall('Victoria', 'hola', NOW)).block).toBe('');
  });

  it('un dato entra sólo si supera el umbral del modelo', async () => {
    await insert({ text: 'Su gato se llama Michi' });
    vectors['Su gato se llama Michi'] = [1, 0, 0];
    vectors['cómo está tu michi?'] = [0.9, 0.1, 0];
    vectors['qué tal el día'] = [0.3, 1, 0];
    expect((await recall.recall('Victoria', 'cómo está tu michi?', NOW)).block).toContain('Michi');
    recall.resetShown();
    expect((await recall.recall('Victoria', 'qué tal el día', NOW)).block).toBe('');
    expect(embeddings.thresholdFor).toHaveBeenCalledWith(EXT);
  });

  it(`con 5 candidatos entran ${MAX_RECALLED}: los eventos cercanos primero, después por parecido`, async () => {
    await insert({ kind: 'event', text: 'evento cercano', eventDate: '2026-11-23' });
    await insert({ text: 'muy parecido' });
    await insert({ text: 'algo parecido' });
    await insert({ text: 'poco parecido' });
    await insert({ text: 'apenas parecido' });
    vectors['msg'] = [1, 0, 0];
    vectors['evento cercano'] = [0, 1, 0];
    vectors['muy parecido'] = [1, 0.1, 0];
    vectors['algo parecido'] = [1, 0.5, 0];
    vectors['poco parecido'] = [1, 0.8, 0];
    vectors['apenas parecido'] = [1, 0.9, 0];
    const out = await recall.recall('Victoria', 'msg', NOW);
    const lines = out.block.split('\n').slice(1);
    expect(lines).toHaveLength(MAX_RECALLED);
    expect(lines[0]).toContain('evento cercano');
    expect(lines[1]).toContain('muy parecido');
    expect(lines[2]).toContain('algo parecido');
  });

  it('no repite en 30 min lo ya mostrado, salvo que el mensaje lo nombre directamente', async () => {
    await insert({ text: 'Su gato se llama Michi' });
    vectors['Su gato se llama Michi'] = [1, 0, 0];
    vectors['michi?'] = [1, 1.5, 0]; // ≈ 0.55: supera 0.5 pero no 0.58
    vectors['tu gato michi'] = [1, 0.05, 0]; // ≈ 0.999: nombra directo
    expect((await recall.recall('Victoria', 'michi?', NOW)).block).toContain('Michi');
    const in10 = new Date(NOW.getTime() + 10 * 60_000);
    vectors['michi otra vez'] = [1, 1.5, 0];
    expect((await recall.recall('Victoria', 'michi otra vez', in10)).block).toBe('');
    expect((await recall.recall('Victoria', 'tu gato michi', in10)).block).toContain('Michi');
    const in31 = new Date(in10.getTime() + REPEAT_WINDOW_MS + 60_000);
    expect((await recall.recall('Victoria', 'michi otra vez', in31)).block).toContain('Michi');
  });

  it('un recuerdo sin vector del modelo vigente se calcula, se guarda y se compara', async () => {
    const m = await insert({ text: 'Su gato se llama Michi', embeddings: [{ model: 'local:otro', vector: [9] }] });
    vectors['Su gato se llama Michi'] = [1, 0, 0];
    vectors['michi'] = [1, 0, 0];
    const out = await recall.recall('Victoria', 'michi', NOW);
    expect(out.block).toContain('Michi');
    expect(embeddings.embedWith).toHaveBeenCalledWith(EXT, ['Su gato se llama Michi'], 'passage');
    const saved = await model.findById(m._id).lean();
    expect(saved?.embeddings.map((e) => e.model).sort()).toEqual([EXT, 'local:otro']);
  });

  it('usa el vector guardado sin volver a calcularlo', async () => {
    await insert({ text: 'Su gato se llama Michi', embeddings: [{ model: EXT, vector: [1, 0, 0] }] });
    vectors['michi'] = [1, 0, 0];
    expect((await recall.recall('Victoria', 'michi', NOW)).block).toContain('Michi');
    expect(embeddings.embedWith).not.toHaveBeenCalled();
  });

  it('sin embeddings cae a palabras clave', async () => {
    embeddings.embed.mockResolvedValue(null);
    await insert({ text: 'Rinde el examen de cálculo', keywords: ['examen', 'calculo'] });
    await insert({ text: 'Su gato se llama Michi', keywords: ['gato', 'michi'] });
    const out = await recall.recall('Victoria', '¿Cómo te fue en el Cálculo?', NOW);
    expect(out.block).toContain('examen de cálculo');
    expect(out.block).not.toContain('Michi');
  });

  it('formato del bloque y refs', async () => {
    const ev = await insert({ kind: 'event', text: 'Rinde el examen de cálculo', eventDate: '2026-11-23', eventTime: '15:00' });
    const fact = await insert({ text: 'Su gato se llama Michi', sensitive: true });
    vectors['michi'] = [1, 0, 0];
    vectors['Su gato se llama Michi'] = [1, 0, 0];
    const out = await recall.recall('Victoria', 'michi', NOW);
    expect(out.block.split('\n')).toEqual([
      '[Recuerdos de Victoria — usalos sólo si vienen al caso; no los recites]',
      'r1 (evento, lunes 23/11 15:00): Rinde el examen de cálculo',
      'r2 (dato, delicado): Su gato se llama Michi',
    ]);
    expect(out.refs.get('r1')).toBe(String(ev._id));
    expect(out.refs.get('r2')).toBe(String(fact._id));
  });

  it('con followUp agrega la nota aunque no haya otros recuerdos', async () => {
    const out = await recall.recall('Victoria', 'hola', NOW, { followUp: 'Rinde el examen de cálculo' });
    expect(out.block).toContain('[Recuerdos de Victoria');
    expect(out.block.endsWith('Preguntale cómo le fue con: Rinde el examen de cálculo')).toBe(true);
  });

  it('marca como usados los mostrados', async () => {
    const m = await insert({ kind: 'event', text: 'examen', eventDate: '2026-11-23' });
    await recall.recall('Victoria', 'hola', NOW);
    expect((await model.findById(m._id))?.useCount).toBe(1);
  });

  it('no trae recuerdos de otra persona', async () => {
    await insert({ userKey: 'leon', username: 'Leon', kind: 'event', text: 'de León', eventDate: '2026-11-23' });
    expect((await recall.recall('Victoria', 'hola', NOW)).block).toBe('');
  });

  // Revisión final (Important 6): un delicado no entra "porque sí" por estar cerca.
  it('un evento delicado cercano entra sólo si el mensaje habla de eso', async () => {
    await insert({ kind: 'event', text: 'Operan a su mamá', eventDate: '2026-11-23', sensitive: true });
    vectors['Operan a su mamá'] = [1, 0, 0];
    vectors['hola'] = [0, 1, 0];
    vectors['cómo sigue tu mamá'] = [1, 0.1, 0];
    expect((await recall.recall('Victoria', 'hola', NOW)).block).toBe('');
    expect((await recall.recall('Victoria', 'cómo sigue tu mamá', NOW)).block).toContain('Operan a su mamá');
  });
});
