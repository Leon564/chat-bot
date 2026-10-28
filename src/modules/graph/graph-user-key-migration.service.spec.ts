import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import {
  rootMongooseTestModule,
  closeMongoConnection,
  syncAllIndexes,
} from '../../common/testing/mongo-test.helper';
import { GraphNode, GraphNodeSchema, GraphNodeDocument } from '../../common/schemas/graph-node.schema';
import { GraphEdge, GraphEdgeSchema } from '../../common/schemas/graph-edge.schema';
import { GraphMigration, GraphMigrationSchema } from '../../common/schemas/graph-migration.schema';
import { GraphService } from './graph.service';
import { GraphUserKeyMigrationService } from './graph-user-key-migration.service';

describe('GraphUserKeyMigrationService (Important #1 — re-clavado de identidad de usuario)', () => {
  let connection: Connection;
  let service: GraphUserKeyMigrationService;
  let nodeModel: Model<GraphNodeDocument>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([
          { name: GraphNode.name, schema: GraphNodeSchema },
          { name: GraphEdge.name, schema: GraphEdgeSchema },
          { name: GraphMigration.name, schema: GraphMigrationSchema },
        ]),
      ],
      providers: [GraphService, GraphUserKeyMigrationService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    service = moduleRef.get<GraphUserKeyMigrationService>(GraphUserKeyMigrationService);
    nodeModel = moduleRef.get<Model<GraphNodeDocument>>(getModelToken(GraphNode.name));
    await syncAllIndexes(connection);
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await connection.collection('bot_nodes').deleteMany({});
    await connection.collection('bot_edges').deleteMany({});
    await connection.collection('bot_migrations').deleteMany({});
  });

  it('re-clava un nodo user cuya key vieja perdió acentos, usando el label como fuente', async () => {
    // Simula un nodo `user` tal como quedó guardado bajo la regla vieja
    // (`normalizeKey`, que quita acentos): key sin tilde, label con tilde
    // preservada (el label nunca se normalizaba).
    await nodeModel.create({ type: 'user', key: 'jose', label: 'José', weight: 3 });

    const stats = await service.run();

    expect(stats!.rekeyed).toBe(1);
    expect(stats!.collisions).toBe(0);
    const node = await nodeModel.findOne({ type: 'user', label: 'José' }).exec();
    expect(node!.key).toBe('josé');
  });

  it('no toca un nodo cuya key ya coincide con la regla nueva', async () => {
    await nodeModel.create({ type: 'user', key: 'nico', label: 'Nico' });

    const stats = await service.run();

    expect(stats!.rekeyed).toBe(0);
    expect(stats!.skipped).toBe(1);
    const node = await nodeModel.findOne({ type: 'user', label: 'Nico' }).exec();
    expect(node!.key).toBe('nico');
  });

  it('nunca toca nodos que no son user', async () => {
    await nodeModel.create({ type: 'work', key: 'cancion', label: 'Canción' });

    await service.run();

    const node = await nodeModel.findOne({ type: 'work' }).exec();
    expect(node!.key).toBe('cancion');
  });

  it('un choque de claves al re-clavar se loguea y NO tumba la migración', async () => {
    // Dos nodos `user` con keys viejas distintas que, al recalcularse desde
    // el label bajo la regla nueva, colisionan en la MISMA key. El índice
    // único {type, key} rechaza el segundo `update` — la migración debe
    // atraparlo, seguir con el resto, y anotar la colisión, sin lanzar.
    await nodeModel.create({ type: 'user', key: 'clave-vieja-a', label: 'nico' });
    await nodeModel.create({ type: 'user', key: 'clave-vieja-b', label: 'Nico' });

    const stats = await service.run();

    expect(stats).not.toBeNull();
    expect(stats!.collisions).toBe(1);
    expect(stats!.rekeyed).toBe(1);

    // Ambos nodos siguen existiendo — el perdedor de la colisión se deja con
    // su key vieja en vez de perderse.
    const total = await nodeModel.countDocuments({ type: 'user' }).exec();
    expect(total).toBe(2);
  });

  it('escribe el centinela y la segunda corrida es no-op', async () => {
    await nodeModel.create({ type: 'user', key: 'jose', label: 'José' });

    const first = await service.run();
    const second = await service.run();

    expect(first!.rekeyed).toBe(1);
    expect(second).toBeNull();
    expect(await connection.collection('bot_migrations').countDocuments({})).toBe(1);
  });

  it('es idempotente si se fuerza tras borrar el centinela: la segunda pasada no vuelve a re-clavar nada', async () => {
    await nodeModel.create({ type: 'user', key: 'jose', label: 'José' });

    await service.run();
    await connection.collection('bot_migrations').deleteMany({});
    const second = await service.run();

    expect(second!.rekeyed).toBe(0);
    expect(second!.skipped).toBe(1);
  });

  it('escribe el centinela igual cuando no había nodos user que migrar', async () => {
    const stats = await service.run();
    expect(stats!.rekeyed).toBe(0);
    expect(await connection.collection('bot_migrations').countDocuments({})).toBe(1);
  });
});
