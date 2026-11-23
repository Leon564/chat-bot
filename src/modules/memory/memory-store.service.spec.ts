import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { rootMongooseTestModule, closeMongoConnection } from '../../common/testing/mongo-test.helper';
import { BotMemory, BotMemoryDocument, BotMemorySchema } from '../../common/schemas/bot-memory.schema';
import { MemoryStore, MAX_ACTIVE_MEMORIES, MAX_NEW_PER_DAY } from './memory-store.service';
import { MemoryDraft } from './memory.types';

// 2026-11-22 10:00 en El Salvador (UTC-6).
const NOW = new Date('2026-11-22T16:00:00Z');

const draft = (over: Partial<MemoryDraft> = {}): MemoryDraft => ({
  kind: 'fact',
  text: 'Su gato se llama Michi',
  keywords: ['gato', 'michi', 'mascota'],
  sensitive: false,
  ...over,
});

describe('MemoryStore', () => {
  let store: MemoryStore;
  let model: Model<BotMemoryDocument>;
  let connection: Connection;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [rootMongooseTestModule(), MongooseModule.forFeature([{ name: BotMemory.name, schema: BotMemorySchema }])],
      providers: [MemoryStore],
    }).compile();
    store = moduleRef.get(MemoryStore);
    model = moduleRef.get(getModelToken(BotMemory.name));
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await model.deleteMany({});
  });

  /** Inserta directo (sin pasar por los topes) con `createdAt` controlado. */
  const insert = (username: string, over: Partial<BotMemory> & { createdAt?: Date } = {}) =>
    model.create({
      userKey: username.trim().toLowerCase(),
      username,
      kind: 'fact',
      text: `dato ${Math.random()}`,
      keywords: [],
      sensitive: false,
      status: 'active',
      ...over,
    });

  it('create guarda con la clave normalizada y devuelve created', async () => {
    const out = await store.create('  Victoria949H ', draft(), NOW);
    expect(out.result).toBe('created');
    expect(out.memory?.userKey).toBe('victoria949h');
    expect(out.memory?.username).toBe('Victoria949H');
    expect(out.memory?.status).toBe('active');
  });

  it('el mismo texto (sin importar mayúsculas, acentos o espacios) es duplicate', async () => {
    await store.create('Victoria', draft({ text: 'Su gato se llama Michí' }), NOW);
    const out = await store.create('victoria', draft({ text: '  su GATO  se llama michi ' }), NOW);
    expect(out.result).toBe('duplicate');
    expect(await model.countDocuments()).toBe(1);
  });

  it('el mismo evento con otra fecha se actualiza (updated)', async () => {
    const ev = draft({ kind: 'event', text: 'Rinde el examen de cálculo', eventDate: '2026-11-27' });
    await store.create('Victoria', ev, NOW);
    const out = await store.create('Victoria', { ...ev, eventDate: '2026-11-30', eventTime: '15:00' }, NOW);
    expect(out.result).toBe('updated');
    expect(out.memory?.eventDate).toBe('2026-11-30');
    expect(out.memory?.eventTime).toBe('15:00');
    expect(await model.countDocuments()).toBe(1);
  });

  // Revisión final (Important 2): el modelo casi nunca repite la frase exacta.
  it('un evento de la misma fecha con dos claves en común es duplicate aunque cambie el texto', async () => {
    await store.create('Victoria', draft({ kind: 'event', text: 'Rinde el examen de cálculo', keywords: ['examen', 'calculo', 'facultad'], eventDate: '2026-11-27' }), NOW);
    const out = await store.create('Victoria', draft({ kind: 'event', text: 'Tiene el parcial de cálculo', keywords: ['parcial', 'calculo', 'examen'], eventDate: '2026-11-27' }), NOW);
    expect(out.result).toBe('duplicate');
    expect(await model.countDocuments()).toBe(1);
  });

  it('otra fecha o una sola clave en común no es duplicado', async () => {
    await store.create('Victoria', draft({ kind: 'event', text: 'Rinde el examen de cálculo', keywords: ['examen', 'calculo'], eventDate: '2026-11-27' }), NOW);
    expect((await store.create('Victoria', draft({ kind: 'event', text: 'Rinde el examen de física', keywords: ['examen', 'fisica'], eventDate: '2026-11-27' }), NOW)).result).toBe('created');
    expect((await store.create('Victoria', draft({ kind: 'event', text: 'Recupera cálculo', keywords: ['examen', 'calculo'], eventDate: '2026-12-04' }), NOW)).result).toBe('created');
  });

  it(`el recuerdo número ${MAX_NEW_PER_DAY + 1} del mismo día local es daily_cap`, async () => {
    for (let i = 0; i < MAX_NEW_PER_DAY; i++) {
      expect((await store.create('Victoria', draft({ text: `dato ${i}` }), NOW)).result).toBe('created');
    }
    expect((await store.create('Victoria', draft({ text: 'uno más' }), NOW)).result).toBe('daily_cap');
    // Al día siguiente (local) vuelve a poder.
    const tomorrow = new Date('2026-11-23T16:00:00Z');
    expect((await store.create('Victoria', draft({ text: 'uno más' }), tomorrow)).result).toBe('created');
  });

  it('el tope diario es por persona', async () => {
    for (let i = 0; i < MAX_NEW_PER_DAY; i++) await store.create('Victoria', draft({ text: `dato ${i}` }), NOW);
    expect((await store.create('Leon', draft(), NOW)).result).toBe('created');
  });

  it(`con ${MAX_ACTIVE_MEMORIES} activos poda el menos usado y más viejo, nunca un evento futuro`, async () => {
    const old = new Date('2026-10-01T00:00:00Z');
    // El evento futuro es el peor candidato por uso y antigüedad, pero se salva.
    await insert('Victoria', { kind: 'event', text: 'evento futuro', eventDate: '2026-12-01', useCount: 0, createdAt: new Date('2026-09-01T00:00:00Z') });
    await insert('Victoria', { text: 'el que se va', useCount: 0, lastUsedAt: null, createdAt: old });
    await insert('Victoria', { text: 'usado una vez', useCount: 1, lastUsedAt: old, createdAt: old });
    for (let i = 3; i < MAX_ACTIVE_MEMORIES; i++) {
      await insert('Victoria', { text: `relleno ${i}`, useCount: 5, lastUsedAt: old, createdAt: old });
    }
    const out = await store.create('Victoria', draft({ text: 'el nuevo' }), NOW);
    expect(out.result).toBe('created');
    const texts = (await model.find({ userKey: 'victoria' })).map((m) => m.text);
    expect(texts).toHaveLength(MAX_ACTIVE_MEMORIES);
    expect(texts).not.toContain('el que se va');
    expect(texts).toContain('evento futuro');
    expect(texts).toContain('usado una vez');
    expect(texts).toContain('el nuevo');
  });

  it('listActive vence los eventos de hace más de 7 días y los deja done', async () => {
    await insert('Victoria', { kind: 'event', text: 'hace 8 días', eventDate: '2026-11-14' });
    await insert('Victoria', { kind: 'event', text: 'hace 6 días', eventDate: '2026-11-16' });
    await insert('Victoria', { text: 'un dato' });
    const texts = (await store.listActive('Victoria', NOW)).map((m) => m.text);
    expect(texts).toEqual(expect.arrayContaining(['hace 6 días', 'un dato']));
    expect(texts).not.toContain('hace 8 días');
    expect((await model.findOne({ text: 'hace 8 días' }))?.status).toBe('done');
  });

  it('listActive no trae los de otra persona ni los cerrados', async () => {
    await insert('Victoria', { text: 'mío' });
    await insert('Leon', { text: 'de otro' });
    await insert('Victoria', { text: 'cerrado', status: 'done' });
    expect((await store.listActive('victoria', NOW)).map((m) => m.text)).toEqual(['mío']);
  });

  it('forgetByPosition borra por posición de listActive (1 = el primero)', async () => {
    await insert('Victoria', { text: 'primero', createdAt: new Date('2026-11-01T00:00:00Z') });
    await insert('Victoria', { text: 'segundo', createdAt: new Date('2026-11-02T00:00:00Z') });
    const gone = await store.forgetByPosition('Victoria', 2, NOW);
    expect(gone?.text).toBe('segundo');
    expect((await store.listActive('Victoria', NOW)).map((m) => m.text)).toEqual(['primero']);
    expect(await store.forgetByPosition('Victoria', 5, NOW)).toBeNull();
    expect(await store.forgetByPosition('Victoria', 0, NOW)).toBeNull();
  });

  it('countActive y forgetAll operan sólo sobre esa persona', async () => {
    await insert('Victoria', { text: 'a' });
    await insert('Victoria', { text: 'b' });
    await insert('Leon', { text: 'c' });
    expect(await store.countActive('Victoria', NOW)).toBe(2);
    expect(await store.forgetAll('Victoria')).toBe(2);
    expect(await store.countActive('Victoria', NOW)).toBe(0);
    expect(await store.countActive('Leon', NOW)).toBe(1);
  });

  it('findOwned sólo devuelve el recuerdo si es de esa persona', async () => {
    const m = await insert('Victoria', { text: 'mío' });
    expect((await store.findOwned('victoria', String(m._id)))?.text).toBe('mío');
    expect(await store.findOwned('Leon', String(m._id))).toBeNull();
    expect(await store.findOwned('Victoria', 'no-es-un-id')).toBeNull();
  });

  it('reschedule cambia la fecha y close lo cierra', async () => {
    const m = await insert('Victoria', { kind: 'event', text: 'examen', eventDate: '2026-11-27' });
    const moved = await store.reschedule(String(m._id), '2026-11-30', '10:00');
    expect(moved?.eventDate).toBe('2026-11-30');
    expect(moved?.eventTime).toBe('10:00');
    await store.close(String(m._id));
    expect((await model.findById(m._id))?.status).toBe('done');
  });

  it('setEmbedding guarda un vector por modelo, reemplazando el del mismo modelo', async () => {
    const m = await insert('Victoria', { text: 'x' });
    await store.setEmbedding(String(m._id), 'ext:a', [1, 2]);
    await store.setEmbedding(String(m._id), 'local:b', [3]);
    await store.setEmbedding(String(m._id), 'ext:a', [9, 9]);
    const saved = await model.findById(m._id).lean();
    expect(saved?.embeddings).toEqual([
      { model: 'local:b', vector: [3] },
      { model: 'ext:a', vector: [9, 9] },
    ]);
  });

  it('markUsed suma uso y fecha', async () => {
    const m = await insert('Victoria', { text: 'x' });
    await store.markUsed([String(m._id)], NOW);
    const saved = await model.findById(m._id);
    expect(saved?.useCount).toBe(1);
    expect(saved?.lastUsedAt?.toISOString()).toBe(NOW.toISOString());
  });
});
