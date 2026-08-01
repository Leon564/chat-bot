import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import {
  rootMongooseTestModule,
  closeMongoConnection,
  syncAllIndexes,
} from '../testing/mongo-test.helper';
import { Memory, MemorySchema, MemoryDocument } from '../schemas/memory.schema';
import { MemoryService } from './memory.service';
import { UtilsService } from './utils.service';

describe('MemoryService — getMemory', () => {
  let connection: Connection;
  let service: MemoryService;
  let model: Model<MemoryDocument>;

  beforeAll(async () => {
    const config = {
      get: jest.fn((clave: string) => {
        const valores: Record<string, unknown> = {
          'bot.useMemory': true,
        };
        return valores[clave];
      }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([{ name: Memory.name, schema: MemorySchema }]),
      ],
      providers: [
        MemoryService,
        UtilsService,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    service = moduleRef.get<MemoryService>(MemoryService);
    model = moduleRef.get<Model<MemoryDocument>>(getModelToken(Memory.name));
    await syncAllIndexes(connection);
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await model.deleteMany({});
  });

  it('con usuario, NO devuelve memorias globales', async () => {
    await model.create({ scope: 'global', user: null, content: 'kei le gusta Solo Leveling' });
    await model.create({ scope: 'user', user: 'Nico', content: 'Nico le gusta Attack on Titan' });

    const memorias = await service.getMemory('Nico');

    expect(memorias.some((m) => m.includes('Solo Leveling'))).toBe(false);
  });

  it('sin usuario, SÍ devuelve memorias globales', async () => {
    await model.create({ scope: 'global', user: null, content: 'kei le gusta Solo Leveling' });

    const memorias = await service.getMemory(undefined);

    expect(memorias.some((m) => m.includes('Solo Leveling'))).toBe(true);
  });

  it('con usuario, las memorias propias del usuario se siguen devolviendo', async () => {
    await model.create({ scope: 'global', user: null, content: 'kei le gusta Solo Leveling' });
    await model.create({ scope: 'user', user: 'Nico', content: 'Nico le gusta Attack on Titan' });

    const memorias = await service.getMemory('Nico');

    expect(memorias.some((m) => m.includes('Attack on Titan'))).toBe(true);
  });
});
