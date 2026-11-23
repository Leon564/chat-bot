import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { rootMongooseTestModule, closeMongoConnection } from '../../common/testing/mongo-test.helper';
import { BotMemory, BotMemoryDocument, BotMemorySchema } from '../../common/schemas/bot-memory.schema';
import { BotFollowup, BotFollowupDocument, BotFollowupSchema } from '../../common/schemas/bot-followup.schema';
import { FollowupService } from './followup.service';
import { MemoryStore } from './memory-store.service';

// Domingo 2026-11-22, 10:00 en El Salvador.
const NOW = new Date('2026-11-22T16:00:00Z');

describe('FollowupService', () => {
  let followups: FollowupService;
  let store: MemoryStore;
  let memories: Model<BotMemoryDocument>;
  let model: Model<BotFollowupDocument>;
  let connection: Connection;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([
          { name: BotMemory.name, schema: BotMemorySchema },
          { name: BotFollowup.name, schema: BotFollowupSchema },
        ]),
      ],
      providers: [FollowupService, MemoryStore],
    }).compile();
    followups = moduleRef.get(FollowupService);
    store = moduleRef.get(MemoryStore);
    memories = moduleRef.get(getModelToken(BotMemory.name));
    model = moduleRef.get(getModelToken(BotFollowup.name));
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await memories.deleteMany({});
    await model.deleteMany({});
  });

  const event = (over: Partial<BotMemory> = {}) =>
    memories.create({
      userKey: 'victoria',
      username: 'Victoria',
      kind: 'event',
      text: 'Rinde el examen de cálculo',
      keywords: [],
      sensitive: false,
      status: 'active',
      eventDate: '2026-11-27',
      ...over,
    });

  const pending = async () =>
    (await model.find({ status: 'pending' }).sort({ phase: 1 }).lean()).map((f) => ({ phase: f.phase, dueAt: f.dueAt.toISOString() }));

  it('un evento sin hora programa el antes a las 09:00 y el después desde el día siguiente', async () => {
    await followups.schedule(await event(), NOW);
    expect(await pending()).toEqual([
      { phase: 'after', dueAt: '2026-11-28T06:00:00.000Z' },
      { phase: 'before', dueAt: '2026-11-27T15:00:00.000Z' },
    ]);
    const after = await model.findOne({ phase: 'after' });
    expect(after?.expiresAt.toISOString()).toBe('2026-12-03T06:00:00.000Z');
  });

  it('un recuerdo delicado sólo tiene después', async () => {
    await followups.schedule(await event({ sensitive: true }), NOW);
    expect((await pending()).map((p) => p.phase)).toEqual(['after']);
  });

  it('un dato no programa nada', async () => {
    await followups.schedule(await event({ kind: 'fact', eventDate: null }), NOW);
    expect(await pending()).toEqual([]);
  });

  // Review Focus: el evento es hoy y ya pasó la hora del "antes".
  it('un evento de hoy guardado después de las 09:00 no tiene antes, sí después', async () => {
    await followups.schedule(await event({ eventDate: '2026-11-22' }), NOW);
    expect((await pending()).map((p) => p.phase)).toEqual(['after']);
  });

  it('reschedule deja sólo los seguimientos de la fecha nueva', async () => {
    const m = await event();
    await followups.schedule(m, NOW);
    m.eventDate = '2026-11-30';
    await followups.reschedule(m, NOW);
    expect(await pending()).toEqual([
      { phase: 'after', dueAt: '2026-12-01T06:00:00.000Z' },
      { phase: 'before', dueAt: '2026-11-30T15:00:00.000Z' },
    ]);
  });

  it('claimDueBefore devuelve el vencido una sola vez', async () => {
    await followups.schedule(await event(), NOW);
    const at = new Date('2026-11-27T15:01:00Z');
    const [a, b] = await Promise.all([followups.claimDueBefore(at), followups.claimDueBefore(at)]);
    const all = [...a, ...b];
    expect(all).toHaveLength(1);
    expect(all[0].user).toBe('Victoria');
    expect(all[0].memory.text).toBe('Rinde el examen de cálculo');
    expect(await followups.claimDueBefore(at)).toEqual([]);
  });

  it('claimDueBefore no devuelve nada antes de hora', async () => {
    await followups.schedule(await event(), NOW);
    expect(await followups.claimDueBefore(new Date('2026-11-27T14:59:00Z'))).toEqual([]);
  });

  it('claimDueBefore salta el antes si el bot estuvo caído y el evento ya pasó', async () => {
    await followups.schedule(await event({ eventTime: '15:00' }), NOW);
    expect(await followups.claimDueBefore(new Date('2026-11-27T22:00:00Z'))).toEqual([]);
    expect(await model.countDocuments({ phase: 'before', status: 'skipped' })).toBe(1);
  });

  it('claimDueBefore salta un recuerdo que ya no está activo', async () => {
    const m = await event();
    await followups.schedule(m, NOW);
    await memories.updateOne({ _id: m._id }, { $set: { status: 'done' } });
    expect(await followups.claimDueBefore(new Date('2026-11-27T15:01:00Z'))).toEqual([]);
  });

  it('claimAfter respeta la ventana', async () => {
    await followups.schedule(await event(), NOW);
    expect(await followups.claimAfter('Victoria', new Date('2026-11-28T05:59:00Z'))).toBeNull();
    expect((await followups.claimAfter('victoria', new Date('2026-11-28T06:01:00Z')))?.text).toBe('Rinde el examen de cálculo');
    expect(await followups.claimAfter('Victoria', new Date('2026-11-28T07:00:00Z'))).toBeNull();
  });

  it('claimAfter no devuelve nada pasada la expiración', async () => {
    await followups.schedule(await event(), NOW);
    expect(await followups.claimAfter('Victoria', new Date('2026-12-03T06:01:00Z'))).toBeNull();
  });

  it('un solo seguimiento por persona por día (antes y después cuentan)', async () => {
    await followups.schedule(await event({ eventDate: '2026-11-26', text: 'el de ayer' }), NOW);
    await followups.schedule(await event({ eventDate: '2026-11-27', text: 'el de hoy' }), NOW);
    // 27/11 09:01: sale la suerte del de hoy…
    expect(await followups.claimDueBefore(new Date('2026-11-27T15:01:00Z'))).toHaveLength(1);
    // …y el "¿cómo te fue?" del de ayer espera al día siguiente.
    expect(await followups.claimAfter('Victoria', new Date('2026-11-27T18:00:00Z'))).toBeNull();
    expect((await followups.claimAfter('Victoria', new Date('2026-11-28T15:00:00Z')))?.text).toBe('el de ayer');
  });

  it('dos antes el mismo día: sale el primero, el segundo se salta', async () => {
    await followups.schedule(await event({ text: 'uno', eventTime: '12:00' }), NOW);
    await followups.schedule(await event({ text: 'dos', eventTime: '18:00' }), NOW);
    expect((await followups.claimDueBefore(new Date('2026-11-27T16:01:00Z'))).map((d) => d.memory.text)).toEqual(['uno']);
    expect(await followups.claimDueBefore(new Date('2026-11-27T22:01:00Z'))).toEqual([]);
  });

  it('cerrar o borrar un recuerdo cancela sus seguimientos', async () => {
    const a = await event({ text: 'a' });
    const b = await event({ text: 'b' });
    await followups.schedule(a, NOW);
    await followups.schedule(b, NOW);
    await store.close(String(a._id));
    expect(await model.countDocuments({ memoryId: a._id, status: 'pending' })).toBe(0);
    expect(await model.countDocuments({ memoryId: b._id, status: 'pending' })).toBe(2);
    await store.forgetAll('Victoria');
    expect(await model.countDocuments({ status: 'pending' })).toBe(0);
  });

  it('forgetByPosition cancela los seguimientos del borrado', async () => {
    const a = await event({ text: 'a' });
    await followups.schedule(a, NOW);
    await store.forgetByPosition('Victoria', 1, NOW);
    expect(await model.countDocuments({ status: 'pending' })).toBe(0);
  });

  // Revisión final (Critical 1): un delicado no sale en un mensaje que no es respuesta.
  it('claimAfter con includeSensitive:false no reclama los delicados (y los deja pendientes)', async () => {
    await followups.schedule(await event({ sensitive: true }), NOW);
    const at = new Date('2026-11-28T15:00:00Z');
    expect(await followups.claimAfter('Victoria', at, { includeSensitive: false })).toBeNull();
    expect((await followups.claimAfter('Victoria', at))?.text).toBe('Rinde el examen de cálculo');
  });

  // Revisión final (Important 5): no preguntar por algo que ya contó hecho.
  it('un evento de ayer no tiene ni antes ni después', async () => {
    await followups.schedule(await event({ eventDate: '2026-11-21' }), NOW);
    expect(await pending()).toEqual([]);
  });

  it('un evento de hoy sin hora guardado después de las 18:00 no tiene después', async () => {
    await followups.schedule(await event({ eventDate: '2026-11-22' }), new Date('2026-11-23T01:00:00Z'));
    expect(await pending()).toEqual([]);
  });

  it('un evento de hoy cuya hora ya pasó no tiene después', async () => {
    await followups.schedule(await event({ eventDate: '2026-11-22', eventTime: '09:30' }), NOW);
    expect(await pending()).toEqual([]);
  });
});
