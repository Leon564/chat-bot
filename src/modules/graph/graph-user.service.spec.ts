import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import {
  rootMongooseTestModule,
  closeMongoConnection,
  syncAllIndexes,
} from '../../common/testing/mongo-test.helper';
import { GraphNode, GraphNodeSchema } from '../../common/schemas/graph-node.schema';
import { GraphEdge, GraphEdgeSchema } from '../../common/schemas/graph-edge.schema';
import { GraphService } from './graph.service';
import { GraphUserService, MAX_FACTS_SHOWN } from './graph-user.service';

describe('GraphUserService', () => {
  let connection: Connection;
  let service: GraphUserService;
  let graph: GraphService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([
          { name: GraphNode.name, schema: GraphNodeSchema },
          { name: GraphEdge.name, schema: GraphEdgeSchema },
        ]),
      ],
      providers: [GraphService, GraphUserService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    service = moduleRef.get<GraphUserService>(GraphUserService);
    graph = moduleRef.get<GraphService>(GraphService);
    await syncAllIndexes(connection);
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await connection.collection('bot_nodes').deleteMany({});
    await connection.collection('bot_edges').deleteMany({});
  });

  const sembrarRelacion = async (
    user: string,
    obra: string,
    tipo: 'likes' | 'dislikes' | 'asked_about' | 'recommended_to' | 'interacts_with',
    veces = 1,
  ) => {
    const u = await graph.upsertNode({ type: 'user', key: user, label: user });
    const nodeType = tipo === 'interacts_with' ? 'user' : 'work';
    const w = await graph.upsertNode({ type: nodeType, key: obra, label: obra });
    for (let i = 0; i < veces; i++) {
      await graph.upsertEdge({ from: u!._id, to: w!._id, type: tipo, source: 'fact' });
    }
    return { u: u!, w: w! };
  };

  it('devuelve vacío para un usuario que no está en el grafo', async () => {
    expect(await service.describe('Nico')).toEqual([]);
  });

  it('devuelve vacío para username vacío', async () => {
    await sembrarRelacion('Nico', 'Berserk', 'likes');
    expect(await service.describe('')).toEqual([]);
  });

  it('lista las aristas del usuario con su relación, etiqueta y peso', async () => {
    await sembrarRelacion('Nico', 'Berserk', 'likes', 3);

    const facts = await service.describe('Nico');

    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({ relation: 'likes', label: 'Berserk', weight: 3 });
  });

  it('NO incluye aristas de otro usuario', async () => {
    await sembrarRelacion('kei', 'Vagabond', 'likes');
    await sembrarRelacion('Nico', 'Berserk', 'likes');

    const facts = await service.describe('Nico');
    const labels = facts.map((f) => f.label);

    expect(labels).toContain('Berserk');
    expect(labels).not.toContain('Vagabond');
  });

  it('ordena por peso descendente', async () => {
    await sembrarRelacion('Nico', 'Poco', 'likes', 1);
    await sembrarRelacion('Nico', 'Mucho', 'likes', 5);

    const facts = await service.describe('Nico');

    expect(facts[0].label).toBe('Mucho');
    expect(facts[1].label).toBe('Poco');
  });

  it('corta en MAX_FACTS_SHOWN', async () => {
    for (let i = 0; i < MAX_FACTS_SHOWN + 10; i++) {
      // Cada obra tiene un peso distinto (i+1) para que el orden sea
      // determinístico y no dependa de empates.
      await sembrarRelacion('Nico', `Obra${i}`, 'likes', i + 1);
    }

    const facts = await service.describe('Nico');

    expect(facts.length).toBe(MAX_FACTS_SHOWN);
    // Sembramos MAX_FACTS_SHOWN + 10 obras con pesos 1..(N+10); el corte debe
    // quedarse con las 40 de MAYOR peso, es decir "Obra10".."Obra49" — no
    // cualquier 40. Esto distingue un corte real de una implementación que
    // simplemente tomara las primeras 40 en orden de inserción.
    const labels = facts.map((f) => f.label);
    expect(labels).toContain(`Obra${MAX_FACTS_SHOWN + 9}`);
    expect(labels).not.toContain('Obra0');
  });

  it('no lanza cuando el grafo falla (devuelve vacío)', async () => {
    await sembrarRelacion('Nico', 'Berserk', 'likes');
    jest.spyOn(graph, 'findNode').mockRejectedValueOnce(new Error('mongo caído'));

    expect(await service.describe('Nico')).toEqual([]);
  });
});
