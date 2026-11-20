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
    expect(list[0]).toEqual({ text: 'primera', createdBy: 'leon', source: 'command' });
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

    expect(await service.removeAt(2)).toEqual({ text: 'b', createdBy: 'leon', source: 'command' });
    expect(await service.texts()).toEqual(['a', 'c']);
    expect(await service.removeAt(3)).toBeNull();
    expect(await service.removeAt(0)).toBeNull();

    // Lo borró de Mongo, no sólo de la caché.
    expect((await fresh().texts())).toEqual(['a', 'c']);
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
