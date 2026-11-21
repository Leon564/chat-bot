import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { rootMongooseTestModule, closeMongoConnection } from '../../common/testing/mongo-test.helper';
import { Reminder, ReminderSchema } from '../../common/schemas/reminder.schema';
import { UtilsService } from '../../common/utils/utils.service';
import { ReminderService, MAX_PENDING_REMINDERS } from './reminder.service';

// 2026-11-20 21:00 en El Salvador (UTC-6).
const NOW = new Date('2026-11-21T03:00:00Z');

describe('ReminderService.parse — la hora se entiende en código', () => {
  it.each([
    ['bot recordame en 2 horas que saque la ropa', '2026-11-21T05:00:00.000Z', 'saque la ropa'],
    ['@Aria recuérdame en media hora de llamar a mamá', '2026-11-21T03:30:00.000Z', 'llamar a mamá'],
    ['bot avisame en 15 min lo de la pizza', '2026-11-21T03:15:00.000Z', 'la pizza'],
    ['bot recordame dentro de un día que vence el plan', '2026-11-22T03:00:00.000Z', 'vence el plan'],
    // A las 21:00, "a las 9" sin am/pm es la próxima: mañana 9:00.
    ['bot avisame a las 9 que hay junta', '2026-11-21T15:00:00.000Z', 'hay junta'],
    ['bot recordame a las 10 de la noche pagar netflix', '2026-11-21T04:00:00.000Z', 'pagar netflix'],
    ['bot recordame a las 22:30 sacar la basura', '2026-11-21T04:30:00.000Z', 'sacar la basura'],
    ['bot recordame mañana a las 8:30 el examen', '2026-11-21T14:30:00.000Z', 'el examen'],
    ['bot recordame que compre pan mañana', '2026-11-21T15:00:00.000Z', 'compre pan'],
  ])('"%s"', (msg, iso, text) => {
    const out = ReminderService.parse(msg, NOW, 'Aria');
    expect(out).not.toBeNull();
    expect(out!.dueAt.toISOString()).toBe(iso);
    expect(out!.text).toBe(text);
  });

  it.each(['bot recordame algo', 'bot recordame en 2 horas', 'bot cómo estás', 'recordame a las 25 tal cosa'])(
    '"%s" no se entiende (sigue al modelo)',
    (msg) => {
      expect(ReminderService.parse(msg, NOW, 'Aria')).toBeNull();
    },
  );

  it('describeWhen habla en hora de El Salvador', () => {
    expect(ReminderService.describeWhen(new Date('2026-11-21T03:20:00Z'), NOW)).toBe('en 20 min');
    expect(ReminderService.describeWhen(new Date('2026-11-21T04:30:00Z'), NOW)).toBe('hoy a las 22:30');
    expect(ReminderService.describeWhen(new Date('2026-11-21T15:00:00Z'), NOW)).toBe('mañana a las 09:00');
    expect(ReminderService.describeWhen(new Date('2026-11-24T16:00:00Z'), NOW)).toBe('el 24/11 a las 10:00');
  });
});

describe('ReminderService — Mongo', () => {
  let service: ReminderService;
  let connection: Connection;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [rootMongooseTestModule(), MongooseModule.forFeature([{ name: Reminder.name, schema: ReminderSchema }])],
      providers: [ReminderService, UtilsService],
    }).compile();
    service = moduleRef.get(ReminderService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await connection.collection('bot_reminders').deleteMany({});
  });

  const in_ = (min: number) => new Date(NOW.getTime() + min * 60_000);

  it('crea, lista en orden, cancela por número', async () => {
    expect(await service.create('Leon', 'b', in_(60), NOW)).toBe('ok');
    expect(await service.create('leon', 'a', in_(30), NOW)).toBe('ok');
    expect((await service.listPending('LEON')).map((r) => r.text)).toEqual(['a', 'b']);
    expect((await service.cancel('leon', 1))?.text).toBe('a');
    expect(await service.cancel('leon', 5)).toBeNull();
    expect((await service.listPending('leon')).map((r) => r.text)).toEqual(['b']);
  });

  it('valida tiempos y el tope por persona', async () => {
    expect(await service.create('leon', 'x', in_(0.5), NOW)).toBe('too_soon');
    expect(await service.create('leon', 'x', in_(31 * 24 * 60), NOW)).toBe('too_far');
    for (let i = 0; i < MAX_PENDING_REMINDERS; i++) await service.create('leon', `r${i}`, in_(10 + i), NOW);
    expect(await service.create('leon', 'otro', in_(90), NOW)).toBe('full');
    expect(await service.create('kei', 'el de kei', in_(90), NOW)).toBe('ok');
  });

  it('claimDue entrega sólo los vencidos, una sola vez', async () => {
    await service.create('leon', 'ya', in_(5), NOW);
    await service.create('kei', 'después', in_(120), NOW);
    const later = in_(10);
    const first = await service.claimDue(later);
    expect(first.map((r) => [r.username, r.text])).toEqual([['leon', 'ya']]);
    expect(await service.claimDue(later)).toEqual([]);
    expect(await service.listPending('leon')).toEqual([]);
  });
});
