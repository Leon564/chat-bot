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

  it('distingue lo que le gusta de lo que ya se le recomendó — por estructura, no sólo presencia', async () => {
    const { u } = await sembrarGusto('Nico', 'Berserk');
    const rec = await graph.upsertNode({ type: 'work', key: 'ORV', label: 'ORV' });
    await graph.upsertEdge({ from: u._id, to: rec!._id, type: 'recommended_to', source: 'signal' });

    const linea = await service.build('Nico', 'hola');
    const lower = linea.toLowerCase();

    const gustaIdx = lower.indexOf('gusta');
    const recomendIdx = lower.indexOf('recomend');
    const berserkIdx = lower.indexOf('berserk');
    const orvIdx = lower.indexOf('orv');

    expect(gustaIdx).toBeGreaterThanOrEqual(0);
    expect(recomendIdx).toBeGreaterThan(gustaIdx);

    // Berserk cuelga de la sección "le gusta": aparece entre su marcador y el
    // de recomendaciones, nunca después.
    expect(berserkIdx).toBeGreaterThan(gustaIdx);
    expect(berserkIdx).toBeLessThan(recomendIdx);

    // ORV cuelga de la sección de recomendaciones. Esta aserción es la que
    // detectaría un bug que junta todo en un solo balde (p. ej. renderizar
    // "ya le recomendé ORV, Berserk"): ahí Berserk reaparecería después del
    // marcador de recomendaciones, y esta línea fallaría.
    expect(orvIdx).toBeGreaterThan(recomendIdx);
    expect(lower.slice(recomendIdx)).not.toContain('berserk');
  });

  it('destaca la obra que la pregunta menciona, si el usuario tiene relación con ella', async () => {
    await sembrarGusto('Nico', 'Berserk');
    await sembrarGusto('Nico', 'Vinland Saga');

    const linea = await service.build('Nico', 'bot qué opinás de berserk?');

    // No alcanza con que "Berserk" esté en algún lado (ya está entre los
    // gustos) ni con que exista ALGÚN resaltado: hay que atar el resaltado
    // al label concreto que se preguntó.
    expect(linea).toMatch(/preguntó por berserk/i);

    // Caso negativo: si `resolveHighlight` matcheara el nodo equivocado,
    // el resaltado señalaría la otra obra que el usuario también tiene entre
    // sus gustos — esta aserción lo detectaría.
    const resaltado = linea.match(/preguntó por ([^.;]+)/i);
    expect(resaltado).not.toBeNull();
    expect(resaltado![1].toLowerCase()).not.toContain('vinland');
  });

  it('respeta el tope de caracteres', async () => {
    for (let i = 0; i < 40; i++) {
      await sembrarGusto('Nico', `Obra con un titulo bastante largo numero ${i}`, i + 1);
    }

    const linea = await service.build('Nico', 'hola');

    expect(linea.length).toBeLessThanOrEqual(MAX_CHARS);
  });

  it('trunca en un límite de palabra completo cuando una sola arista ya supera el tope', async () => {
    // Con MAX_EDGES=6 acotando la consulta, 40 obras cortas nunca fuerzan la
    // rama de recorte de `truncate()` (ver reporte de la ronda anterior).
    // Este test siembra UNA sola arista cuyo label ya es más largo que
    // MAX_CHARS por sí solo, para forzar el recorte de forma determinística.
    const tituloLargo = Array.from({ length: 60 }, (_, i) => `palabra${i}`).join(' ');
    await sembrarGusto('Nico', tituloLargo);

    const linea = await service.build('Nico', 'hola');
    const sinTruncar = `Sobre Nico: le gusta ${tituloLargo}.`;

    // Realmente entró a la rama de truncado, no es casualidad que ya calzara.
    expect(sinTruncar.length).toBeGreaterThan(MAX_CHARS);
    expect(linea.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(linea.length).toBeLessThan(sinTruncar.length);

    // El corte cae en un límite de palabra completo: el último token no es
    // una palabra partida a mitad de camino.
    const ultimoToken = linea.trim().split(' ').pop()!;
    expect(ultimoToken).toMatch(/^palabra\d+$/);
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
