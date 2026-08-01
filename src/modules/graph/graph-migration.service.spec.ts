import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import {
  rootMongooseTestModule,
  closeMongoConnection,
  syncAllIndexes,
} from '../../common/testing/mongo-test.helper';
import { GraphNode, GraphNodeSchema } from '../../common/schemas/graph-node.schema';
import { GraphEdge, GraphEdgeSchema } from '../../common/schemas/graph-edge.schema';
import { GraphMigration, GraphMigrationSchema } from '../../common/schemas/graph-migration.schema';
import { Memory, MemorySchema, MemoryDocument } from '../../common/schemas/memory.schema';
import { GraphService } from './graph.service';
import { GraphMigrationService } from './graph-migration.service';

describe('GraphMigrationService', () => {
  let connection: Connection;
  let service: GraphMigrationService;
  let graph: GraphService;
  let memoryModel: Model<MemoryDocument>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([
          { name: GraphNode.name, schema: GraphNodeSchema },
          { name: GraphEdge.name, schema: GraphEdgeSchema },
          { name: GraphMigration.name, schema: GraphMigrationSchema },
          { name: Memory.name, schema: MemorySchema },
        ]),
      ],
      providers: [GraphService, GraphMigrationService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    service = moduleRef.get<GraphMigrationService>(GraphMigrationService);
    graph = moduleRef.get<GraphService>(GraphService);
    memoryModel = moduleRef.get<Model<MemoryDocument>>(getModelToken(Memory.name));
    await syncAllIndexes(connection);
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await connection.collection('bot_nodes').deleteMany({});
    await connection.collection('bot_edges').deleteMany({});
    await connection.collection('bot_migrations').deleteMany({});
    await connection.collection('memories').deleteMany({});
  });

  it('convierte una memoria de gusto en arista likes hacia un topic', async () => {
    await memoryModel.create({ scope: 'user', user: 'Nico', content: 'A Nico le gusta Attack on Titan' });

    const stats = await service.run();

    expect(stats!.migrated).toBe(1);
    const nico = await graph.findNode('user', 'nico');
    const top = await graph.topEdges(nico!._id, ['likes'], 10);
    expect(top).toHaveLength(1);
    expect(top[0].nodeType).toBe('topic');
  });

  it('enlaza contra un nodo existente cuando el alias resuelve', async () => {
    await graph.upsertNode({
      type: 'work', key: 'anilist:16498', label: 'Attack on Titan',
      aliases: ['attack on titan'],
    });
    await memoryModel.create({ scope: 'user', user: 'Nico', content: 'A Nico le gusta Attack on Titan' });

    await service.run();

    const nico = await graph.findNode('user', 'nico');
    const top = await graph.topEdges(nico!._id, ['likes'], 10);
    expect(top[0].nodeType).toBe('work');
    expect(top[0].label).toBe('Attack on Titan');
  });

  it('ignora las memorias globales (sin usuario)', async () => {
    await memoryModel.create({ scope: 'global', user: null, content: 'El creador es Leon564' });

    const stats = await service.run();

    expect(stats!.migrated).toBe(0);
    expect(stats!.skipped).toBe(1);
  });

  it('descarta memorias demasiado cortas', async () => {
    await memoryModel.create({ scope: 'user', user: 'Nico', content: 'ok' });

    const stats = await service.run();
    expect(stats!.skipped).toBe(1);
  });

  it('descarta una memoria factual que no es un gusto (sin patrón de LIKE_PREFIXES)', async () => {
    await memoryModel.create({ scope: 'user', user: 'Nico', content: 'Nico tiene 25 años' });

    const stats = await service.run();

    expect(stats!.migrated).toBe(0);
    expect(stats!.skipped).toBe(1);
    const nico = await graph.findNode('user', 'nico');
    expect(nico).toBeNull();
  });

  it('descarta cuando el objeto queda demasiado corto tras recortar puntuación', async () => {
    await memoryModel.create({ scope: 'user', user: 'Nico', content: 'A Nico le gusta ¿?' });

    const stats = await service.run();

    expect(stats!.migrated).toBe(0);
    expect(stats!.skipped).toBe(1);
  });

  it('NO borra la colección memories', async () => {
    await memoryModel.create({ scope: 'user', user: 'Nico', content: 'A Nico le gusta Berserk' });

    await service.run();

    expect(await memoryModel.countDocuments({})).toBe(1);
  });

  it('escribe el centinela y la segunda corrida es no-op', async () => {
    await memoryModel.create({ scope: 'user', user: 'Nico', content: 'A Nico le gusta Berserk' });

    const first = await service.run();
    const second = await service.run();

    expect(first!.migrated).toBe(1);
    expect(second).toBeNull();
    expect(await connection.collection('bot_migrations').countDocuments({})).toBe(1);
  });

  it('es idempotente si se fuerza tras borrar el centinela', async () => {
    await memoryModel.create({ scope: 'user', user: 'Nico', content: 'A Nico le gusta Berserk' });

    await service.run();
    await connection.collection('bot_migrations').deleteMany({});
    await service.run();

    const nico = await graph.findNode('user', 'nico');
    const top = await graph.topEdges(nico!._id, ['likes'], 10);
    expect(top).toHaveLength(1);
  });

  it('escribe el centinela igual cuando no había nada que migrar', async () => {
    // Una base sin memorias previas es un caso válido, no un fallo: dejar el
    // centinela evita re-escanear la colección en cada arranque.
    const stats = await service.run();
    expect(stats!.migrated).toBe(0);
    expect(await connection.collection('bot_migrations').countDocuments({})).toBe(1);
  });
});
