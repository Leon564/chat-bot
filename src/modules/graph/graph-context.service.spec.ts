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
import { GraphContextService, MAX_EDGES, MAX_CHARS } from './graph-context.service';

describe('GraphContextService', () => {
  let connection: Connection;
  let service: GraphContextService;
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
      providers: [GraphService, GraphContextService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    service = moduleRef.get<GraphContextService>(GraphContextService);
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

  const sembrarGusto = async (user: string, obra: string, veces = 1) => {
    const u = await graph.upsertNode({ type: 'user', key: user, label: user });
    const w = await graph.upsertNode({ type: 'work', key: obra, label: obra, aliases: [obra] });
    for (let i = 0; i < veces; i++) {
      await graph.upsertEdge({ from: u!._id, to: w!._id, type: 'likes', source: 'fact' });
    }
    return { u: u!, w: w! };
  };

  it('devuelve cadena vacía para un usuario sin nada en el grafo', async () => {
    expect(await service.build('Nico', 'hola')).toBe('');
  });

  it('devuelve cadena vacía si el username viene vacío', async () => {
    await sembrarGusto('Nico', 'Berserk');
    expect(await service.build('', 'hola')).toBe('');
  });

  it('menciona lo que le gusta al usuario', async () => {
    await sembrarGusto('Nico', 'Berserk');

    const linea = await service.build('Nico', 'hola');

    expect(linea).toContain('Nico');
    expect(linea).toContain('Berserk');
  });

  it('NO menciona lo que le gusta a otro usuario', async () => {
    await sembrarGusto('kei', 'Vagabond');
    await sembrarGusto('Nico', 'Berserk');

    const linea = await service.build('Nico', 'hola');

    expect(linea).toContain('Berserk');
    expect(linea).not.toContain('Vagabond');
  });

  it('ordena por peso: lo más reforzado primero', async () => {
    await sembrarGusto('Nico', 'Poco', 1);
    await sembrarGusto('Nico', 'Mucho', 5);

    const linea = await service.build('Nico', 'hola');

    expect(linea.indexOf('Mucho')).toBeLessThan(linea.indexOf('Poco'));
  });

  it('distingue lo que le gusta de lo que ya se le recomendó', async () => {
    const { u } = await sembrarGusto('Nico', 'Berserk');
    const rec = await graph.upsertNode({ type: 'work', key: 'ORV', label: 'ORV' });
    await graph.upsertEdge({ from: u._id, to: rec!._id, type: 'recommended_to', source: 'signal' });

    const linea = await service.build('Nico', 'hola');

    // Las dos aparecen, pero en secciones distintas — el prompt tiene que
    // poder distinguir "le gusta" de "ya se lo recomendé".
    expect(linea).toContain('Berserk');
    expect(linea).toContain('ORV');
    expect(linea.toLowerCase()).toContain('recomend');
  });

  it('destaca la obra que la pregunta menciona, si el usuario tiene relación con ella', async () => {
    await sembrarGusto('Nico', 'Berserk');
    await sembrarGusto('Nico', 'Vinland Saga');

    const linea = await service.build('Nico', 'bot qué opinás de berserk?');

    // Berserk es lo que se preguntó: tiene que estar, y el test verifica que
    // la línea lo señala explícitamente, no que aparezca por casualidad al
    // estar entre los gustos.
    expect(linea.toLowerCase()).toContain('berserk');
    expect(linea.toLowerCase()).toMatch(/pregunt|sobre esto|justo/);
  });

  it('respeta el tope de caracteres', async () => {
    for (let i = 0; i < 40; i++) {
      await sembrarGusto('Nico', `Obra con un titulo bastante largo numero ${i}`, i + 1);
    }

    const linea = await service.build('Nico', 'hola');

    expect(linea.length).toBeLessThanOrEqual(MAX_CHARS);
  });

  it('no incluye más de MAX_EDGES relaciones', async () => {
    for (let i = 0; i < 20; i++) await sembrarGusto('Nico', `Obra${i}`, i + 1);

    const linea = await service.build('Nico', 'hola');
    // OJO: `linea.includes('Obra1')` daría falso positivo con "Obra14",
    // "Obra15" ... "Obra19" (substring), inflando el conteo aunque la
    // implementación respete MAX_EDGES. El lookahead exige que no siga otro
    // dígito, para contar "Obra1" sólo cuando es exactamente esa obra.
    const mencionadas = Array.from({ length: 20 }, (_, i) => `Obra${i}`)
      .filter((o) => new RegExp(`${o}(?!\\d)`).test(linea));

    expect(mencionadas.length).toBeLessThanOrEqual(MAX_EDGES);
  });

  it('devuelve cadena vacía cuando el grafo falla, sin lanzar', async () => {
    await sembrarGusto('Nico', 'Berserk');
    jest.spyOn(graph, 'findNode').mockRejectedValueOnce(new Error('mongo caído'));

    expect(await service.build('Nico', 'hola')).toBe('');
  });
});
