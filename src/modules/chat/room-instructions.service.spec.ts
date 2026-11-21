import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { rootMongooseTestModule, closeMongoConnection } from '../../common/testing/mongo-test.helper';
import {
  RoomInstruction,
  RoomInstructionDocument,
  RoomInstructionSchema,
} from '../../common/schemas/room-instruction.schema';
import {
  RoomInstructionsService,
  MAX_ROOM_INSTRUCTIONS,
  MAX_ROOM_INSTRUCTION_LENGTH,
} from './room-instructions.service';

describe('RoomInstructionsService', () => {
  let connection: Connection;
  let model: Model<RoomInstructionDocument>;
  let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([{ name: RoomInstruction.name, schema: RoomInstructionSchema }]),
      ],
      providers: [RoomInstructionsService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    model = moduleRef.get<Model<RoomInstructionDocument>>(getModelToken(RoomInstruction.name));
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  /** Instancia nueva por test: la caché en memoria es por instancia. */
  const fresh = () => new RoomInstructionsService(model);

  /** Con reloj controlable, para probar los vencimientos sin esperar. */
  class Clocked extends RoomInstructionsService {
    t = Date.now();
    protected now(): number {
      return this.t;
    }
  }

  beforeEach(async () => {
    await model.deleteMany({});
  });

  it('agrega en orden y numera desde 1', async () => {
    const service = fresh();
    expect(await service.add('Respondé con colores', 'leon', 'command')).toEqual({ ok: true, position: 1 });
    expect(await service.add('Usá emojis', 'kei', 'model')).toEqual({ ok: true, position: 2 });

    expect(await service.texts()).toEqual(['Respondé con colores', 'Usá emojis']);
  });

  it('persiste: otra instancia (un reinicio) las lee de Mongo en el mismo orden', async () => {
    await fresh().add('primera', 'leon', 'command');
    await fresh().add('segunda', 'leon', 'command');

    const list = await fresh().list();
    expect(list.map((i) => i.text)).toEqual(['primera', 'segunda']);
    expect(list[0]).toEqual({ text: 'primera', createdBy: 'leon', source: 'command', expiresAt: null });
  });

  it('normaliza a una línea y recorta el largo', async () => {
    const service = fresh();
    await service.add('  hola\n\n  mundo  ', 'leon', 'command');
    await service.add('x'.repeat(MAX_ROOM_INSTRUCTION_LENGTH + 50), 'leon', 'command');

    const [a, b] = await service.texts();
    expect(a).toBe('hola mundo');
    expect(b.length).toBe(MAX_ROOM_INSTRUCTION_LENGTH);
  });

  it('rechaza vacías y duplicadas (sin distinguir mayúsculas)', async () => {
    const service = fresh();
    expect(await service.add('   ', 'leon', 'command')).toEqual({ ok: false, reason: 'empty' });
    await service.add('Usá colores', 'leon', 'command');
    expect(await service.add('usá COLORES', 'kei', 'model')).toEqual({ ok: false, reason: 'duplicate' });
    expect(await model.countDocuments()).toBe(1);
  });

  it(`no pasa de ${MAX_ROOM_INSTRUCTIONS}`, async () => {
    const service = fresh();
    for (let i = 0; i < MAX_ROOM_INSTRUCTIONS; i++) await service.add(`regla ${i}`, 'leon', 'command');
    expect(await service.add('una más', 'leon', 'command')).toEqual({ ok: false, reason: 'full' });
    expect(await model.countDocuments()).toBe(MAX_ROOM_INSTRUCTIONS);
  });

  it('quita por número y renumera; fuera de rango devuelve null', async () => {
    const service = fresh();
    await service.add('a', 'leon', 'command');
    await service.add('b', 'leon', 'command');
    await service.add('c', 'leon', 'command');

    expect(await service.removeAt(2)).toEqual({ text: 'b', createdBy: 'leon', source: 'command', expiresAt: null });
    expect(await service.texts()).toEqual(['a', 'c']);
    expect(await service.removeAt(3)).toBeNull();
    expect(await service.removeAt(0)).toBeNull();

    // Lo borró de Mongo, no sólo de la caché.
    expect((await fresh().texts())).toEqual(['a', 'c']);
  });

  it('una instrucción temporal deja de aplicar al vencer y renumera las demás', async () => {
    const service = new Clocked(model);
    await service.add('fija', 'leon', 'command');
    await service.add('temporal', 'leon', 'command', 60 * 60_000);
    await service.add('otra fija', 'leon', 'command');

    const [, temporal] = await service.list();
    expect(temporal.expiresAt).toBeInstanceOf(Date);
    expect(await service.texts()).toEqual(['fija', 'temporal', 'otra fija']);

    service.t += 60 * 60_000 + 1;
    expect(await service.texts()).toEqual(['fija', 'otra fija']);
    // `quitar 2` apunta a lo que se ve ahora, no a la vencida.
    expect((await service.removeAt(2))?.text).toBe('otra fija');

    // También se fue de Mongo. El borrado corre de fondo (fire-and-forget), así
    // que se espera a que termine en vez de asumir un tick: en el runner de CI,
    // más lento, un solo `setImmediate` no alcanzaba y el test fallaba a veces.
    let left = 1;
    for (let i = 0; i < 50 && left > 0; i++) {
      left = await model.countDocuments({ text: 'temporal' });
      if (left > 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(left).toBe(0);
  });

  it('una vencida no cuenta para el tope ni como duplicada', async () => {
    const service = new Clocked(model);
    await service.add('usá colores', 'leon', 'command', 60_000);
    service.t += 60_001;
    expect(await service.add('usá colores', 'leon', 'command')).toEqual({ ok: true, position: 1 });
  });

  it('clear borra todas y devuelve cuántas había', async () => {
    const service = fresh();
    await service.add('a', 'leon', 'command');
    await service.add('b', 'leon', 'command');

    expect(await service.clear()).toBe(2);
    expect(await service.texts()).toEqual([]);
    expect(await model.countDocuments()).toBe(0);
  });
});

describe('RoomInstructionsService.parseDuration', () => {
  it.each([
    ['30m', 30 * 60_000],
    ['90min', 90 * 60_000],
    ['2h', 2 * 3_600_000],
    ['3 horas', 3 * 3_600_000],
    ['1d', 86_400_000],
    ['2días', 2 * 86_400_000],
  ])('"%s" → %d ms', (raw, ms) => {
    expect(RoomInstructionsService.parseDuration(raw)).toBe(ms);
  });

  it.each(['', 'hola', '2', '0m', '31d', '2x', 'h2'])('"%s" no es una duración válida', (raw) => {
    expect(RoomInstructionsService.parseDuration(raw)).toBeNull();
  });
});
