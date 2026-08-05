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
import { GraphIngestService } from './graph-ingest.service';
import { UtilsService } from '../../common/utils/utils.service';

describe('GraphUserService', () => {
  let connection: Connection;
  let service: GraphUserService;
  let graph: GraphService;
  // Sólo para el describe de Task 3 (contexto cruzado): sembrar exactamente
  // lo que deja `ingestFactAbout` cuando alguien habla de un tercero, en vez
  // de escribir la arista a mano con `graph.upsertEdge` — así el test
  // verifica la contención real (`!olvida`/`!quesabes` sobre lo que
  // `GraphIngestService` efectivamente persiste), no una simulación aparte.
  let ingest: GraphIngestService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([
          { name: GraphNode.name, schema: GraphNodeSchema },
          { name: GraphEdge.name, schema: GraphEdgeSchema },
        ]),
      ],
      providers: [GraphService, GraphUserService, GraphIngestService, UtilsService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    service = moduleRef.get<GraphUserService>(GraphUserService);
    graph = moduleRef.get<GraphService>(GraphService);
    ingest = moduleRef.get<GraphIngestService>(GraphIngestService);
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

  // ─── !olvida (Task 3, fase 5a) ──────────────────────────────────────────

  describe('findForgettable / forget / forgetAll', () => {
    it('forget borra las aristas del usuario cuyo destino matchea el término', async () => {
      const { w } = await sembrarRelacion('Nico', 'Berserk', 'likes');

      const deleted = await service.forget('Nico', 'Berserk');

      expect(deleted).toBe(1);
      const restantes = await connection.collection('bot_edges').countDocuments({});
      expect(restantes).toBe(0);
      // El nodo destino no se toca, sólo la arista.
      const nodoSigue = await connection.collection('bot_nodes').findOne({ _id: w._id });
      expect(nodoSigue).not.toBeNull();
    });

    it('forget NO borra aristas de otro usuario hacia el mismo destino', async () => {
      const u1 = await graph.upsertNode({ type: 'user', key: 'Nico', label: 'Nico' });
      const u2 = await graph.upsertNode({ type: 'user', key: 'kei', label: 'kei' });
      const w = await graph.upsertNode({ type: 'work', key: 'Berserk', label: 'Berserk' });
      await graph.upsertEdge({ from: u1!._id, to: w!._id, type: 'likes', source: 'fact' });
      await graph.upsertEdge({ from: u2!._id, to: w!._id, type: 'likes', source: 'fact' });

      const deleted = await service.forget('Nico', 'Berserk');

      expect(deleted).toBe(1);
      const keiEdge = await connection
        .collection('bot_edges')
        .findOne({ from: u2!._id, to: w!._id, type: 'likes' });
      expect(keiEdge).not.toBeNull();
    });

    it('forget NO borra el nodo destino, sólo la arista', async () => {
      const { w } = await sembrarRelacion('Nico', 'Berserk', 'likes');

      await service.forget('Nico', 'Berserk');

      const nodo = await connection.collection('bot_nodes').findOne({ _id: w._id });
      expect(nodo).not.toBeNull();
      expect(nodo!.label).toBe('Berserk');
    });

    it('forget con un término que no matchea nada devuelve 0 y no borra nada', async () => {
      await sembrarRelacion('Nico', 'Berserk', 'likes');

      const deleted = await service.forget('Nico', 'Vagabond');

      expect(deleted).toBe(0);
      const restantes = await connection.collection('bot_edges').countDocuments({});
      expect(restantes).toBe(1);
    });

    it('forget matchea por etiqueta sin distinguir mayúsculas', async () => {
      await sembrarRelacion('Nico', 'Berserk', 'likes');

      const deleted = await service.forget('Nico', 'BERSERK');

      expect(deleted).toBe(1);
    });

    it('forget matchea por etiqueta sin distinguir acentos', async () => {
      await sembrarRelacion('Nico', 'Pokémon', 'likes');

      const deleted = await service.forget('Nico', 'pokemon');

      expect(deleted).toBe(1);
    });

    it('forget matchea por alias del nodo destino', async () => {
      const u = await graph.upsertNode({ type: 'user', key: 'Nico', label: 'Nico' });
      const w = await graph.upsertNode({
        type: 'work',
        key: 'solo leveling',
        label: 'Solo Leveling',
        aliases: ['sll', 'el cazador mas debil'],
      });
      await graph.upsertEdge({ from: u!._id, to: w!._id, type: 'asked_about', source: 'fact' });

      const deleted = await service.forget('Nico', 'SLL');

      expect(deleted).toBe(1);
    });

    it('forgetAll borra todas las aristas SALIENTES del usuario', async () => {
      await sembrarRelacion('Nico', 'Berserk', 'likes');
      await sembrarRelacion('Nico', 'Vagabond', 'dislikes');

      const deleted = await service.forgetAll('Nico');

      expect(deleted).toBe(2);
      const restantes = await connection
        .collection('bot_edges')
        .countDocuments({});
      expect(restantes).toBe(0);
    });

    it('forgetAll NO borra las aristas entrantes de otros hacia él (interacts_with es bidireccional)', async () => {
      // Nico habló con kei: se registran DOS aristas, una por dirección —
      // Nico->kei (dato de Nico) y kei->Nico (dato de kei, dice que KEI le
      // habló a Nico). `!olvida todo` de Nico borra sólo la primera: la
      // segunda es tan de kei como la primera es de Nico, y borrarla sería
      // tocar datos ajenos aunque el par de nodos sea el mismo.
      const nico = await graph.upsertNode({ type: 'user', key: 'Nico', label: 'Nico' });
      const kei = await graph.upsertNode({ type: 'user', key: 'kei', label: 'kei' });
      await graph.upsertEdge({ from: nico!._id, to: kei!._id, type: 'interacts_with', source: 'signal' });
      await graph.upsertEdge({ from: kei!._id, to: nico!._id, type: 'interacts_with', source: 'signal' });

      const deleted = await service.forgetAll('Nico');

      expect(deleted).toBe(1);
      const keiToNico = await connection
        .collection('bot_edges')
        .findOne({ from: kei!._id, to: nico!._id, type: 'interacts_with' });
      expect(keiToNico).not.toBeNull();
    });

    it('forgetAll no borra el nodo del propio usuario', async () => {
      const { u } = await sembrarRelacion('Nico', 'Berserk', 'likes');

      await service.forgetAll('Nico');

      const nodo = await connection.collection('bot_nodes').findOne({ _id: u._id });
      expect(nodo).not.toBeNull();
    });

    it('findForgettable devuelve lo que forget borraría, sin borrar nada', async () => {
      await sembrarRelacion('Nico', 'Berserk', 'likes', 2);

      const preview = await service.findForgettable('Nico', 'Berserk');

      expect(preview).toHaveLength(1);
      expect(preview[0]).toEqual({ relation: 'likes', label: 'Berserk', weight: 2 });
      const restantes = await connection.collection('bot_edges').countDocuments({});
      expect(restantes).toBe(1);
    });

    it('findForgettable no lanza cuando el grafo falla (devuelve vacío)', async () => {
      await sembrarRelacion('Nico', 'Berserk', 'likes');
      jest.spyOn(graph, 'findNode').mockRejectedValueOnce(new Error('mongo caído'));

      expect(await service.findForgettable('Nico', 'Berserk')).toEqual([]);
    });

    it('forget no lanza cuando el grafo falla (devuelve 0, no borra nada)', async () => {
      await sembrarRelacion('Nico', 'Berserk', 'likes');
      jest.spyOn(graph, 'edgesFrom').mockRejectedValueOnce(new Error('mongo caído'));

      expect(await service.forget('Nico', 'Berserk')).toBe(0);
      const restantes = await connection.collection('bot_edges').countDocuments({});
      expect(restantes).toBe(1);
    });

    it('forgetAll no lanza cuando el grafo falla (devuelve 0, no borra nada)', async () => {
      await sembrarRelacion('Nico', 'Berserk', 'likes');
      jest.spyOn(graph, 'deleteEdgesFrom').mockRejectedValueOnce(new Error('mongo caído'));

      expect(await service.forgetAll('Nico')).toBe(0);
      const restantes = await connection.collection('bot_edges').countDocuments({});
      expect(restantes).toBe(1);
    });

    it('countForgettableAll cuenta las aristas salientes sin borrar nada', async () => {
      await sembrarRelacion('Nico', 'Berserk', 'likes');
      await sembrarRelacion('Nico', 'Vagabond', 'dislikes');

      const total = await service.countForgettableAll('Nico');

      expect(total).toBe(2);
      const restantes = await connection.collection('bot_edges').countDocuments({});
      expect(restantes).toBe(2);
    });

    it('forget con un término vacío o de menos de 3 caracteres devuelve 0 sin consultar el grafo', async () => {
      await sembrarRelacion('Nico', 'Berserk', 'likes');
      // `jest.spyOn` sin `mockRestore`/`clearAllMocks` entre tests de este
      // archivo acumula llamadas de tests previos — se compara el conteo
      // antes/después en vez de `.not.toHaveBeenCalled()` para no depender
      // de si el spy venía "limpio" (mismo patrón que graph-cache.service.spec.ts).
      const findNodeSpy = jest.spyOn(graph, 'findNode');
      const llamadasPrevias = findNodeSpy.mock.calls.length;

      expect(await service.forget('Nico', '')).toBe(0);
      expect(await service.forget('Nico', 'ab')).toBe(0);
      expect(await service.findForgettable('Nico', '')).toEqual([]);
      expect(await service.findForgettable('Nico', 'ab')).toEqual([]);
      expect(findNodeSpy.mock.calls.length).toBe(llamadasPrevias);
    });
  });

  // ─── Contexto cruzado (Task 3) — !olvida/!quesabes alcanzan lo que otro plantó ──

  describe('contención de riesgo: hechos sin atribución sembrados por OTRA persona', () => {
    // REENCUADRE (revisión de código, ronda 1, Important #3) — qué prueban
    // estos dos tests y, sobre todo, qué NO prueban.
    //
    // `ingestFactAbout` e `ingestFact` producen ARISTAS ESTRUCTURALMENTE
    // IDÉNTICAS: mismo `type`, mismo `source` ('fact' por default en los
    // dos), mismo `weight` inicial, mismo nodo destino — sólo difiere
    // `lastSeenAt`. La arista NUNCA guarda quién la escribió: fue una
    // decisión explícita y ya tomada del dueño del proyecto (rechazada dos
    // veces durante el diseño) que los hechos sobre terceros van SIN
    // atribución. Por eso estos dos tests NO PUEDEN, ni deberían poder,
    // distinguir "esto lo plantó otra persona" de "me lo planté yo mismo" —
    // si se reemplazara `ingest.ingestFactAbout('lyna', 'likes', 'Berserk')`
    // por un auto-plantado equivalente (`ingest.ingestFact('lyna', 'likes',
    // 'Berserk')`), los dos tests seguirían exactamente igual de verdes. Eso
    // NO es un hueco de cobertura que haya que cerrar agregando atribución
    // — sería deshacer la decisión ya tomada — es la consecuencia correcta
    // y esperada del diseño sin atribución.
    //
    // Lo que SÍ verifican, y por eso valen igual: que `forget`/`describe`
    // (la contención real de `!olvida`/`!quesabes`) no hacen NINGÚN tipo de
    // excepción por el origen de la arista — ambos sólo miran `from:
    // userNode._id`, sin filtrar por `source` ni por ningún otro campo — así
    // que un hecho sembrado vía `ingestFactAbout` (que puede aterrizar en un
    // nodo `topic` si el objeto no resuelve por alias, exactamente el mismo
    // camino que ya cubre `ingestFact` en `graph-ingest.service.spec.ts`) es
    // tan alcanzable por el borrado/la consulta como cualquier otro. La
    // contención es ESTRUCTURAL (nace de que ambos servicios ignoran el
    // origen), no algo que un test de comportamiento pueda discriminar.
    it('!olvida borra un hecho que plantó OTRA persona sobre uno', async () => {
      await graph.upsertNode({ type: 'user', key: 'lyna', label: 'lyna' });
      // Exactamente lo que deja `ingestFactAbout` cuando leon habla de lyna.
      await ingest.ingestFactAbout('lyna', 'likes', 'Berserk');
      const lyna = await graph.findNode('user', 'lyna');
      expect(await graph.countEdgesFrom(lyna!._id)).toBe(1);

      const deletedCount = await service.forget('lyna', 'Berserk');

      expect(deletedCount).toBeGreaterThan(0);
      expect(await graph.countEdgesFrom(lyna!._id)).toBe(0);
    });

    it('!quesabes se lo muestra antes de que lo borre', async () => {
      await graph.upsertNode({ type: 'user', key: 'lyna', label: 'lyna' });
      await ingest.ingestFactAbout('lyna', 'likes', 'Berserk');

      const facts = await service.describe('lyna');

      // `toContainEqual` sobre el objeto completo (relación + label + peso),
      // no `JSON.stringify(...).toContain('Berserk')` (revisión de código,
      // ronda 1, Important #3): esa aserción floja pasaría igual si la
      // relación viniera mal (p. ej. 'dislikes' en vez de 'likes') o si
      // vinieran cuarenta hechos ajenos de otro test — con `toContainEqual`
      // hace falta que ESTE hecho puntual (relación Y objeto) esté presente
      // tal cual, tolerando que haya otros hechos alrededor.
      expect(facts).toContainEqual({ relation: 'likes', label: 'Berserk', weight: 1 });
    });
  });
});
