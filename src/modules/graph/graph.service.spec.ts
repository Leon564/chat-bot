import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import {
  rootMongooseTestModule,
  closeMongoConnection,
  syncAllIndexes,
} from '../../common/testing/mongo-test.helper';
import { GraphNode, GraphNodeSchema } from '../../common/schemas/graph-node.schema';
import { GraphEdge, GraphEdgeSchema, GraphEdgeDocument } from '../../common/schemas/graph-edge.schema';
import { GraphService, MAX_PEERS } from './graph.service';

describe('GraphService — nodos', () => {
  let connection: Connection;
  let service: GraphService;
  let edgeModel: Model<GraphEdgeDocument>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([
          { name: GraphNode.name, schema: GraphNodeSchema },
          { name: GraphEdge.name, schema: GraphEdgeSchema },
        ]),
      ],
      providers: [GraphService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    service = moduleRef.get<GraphService>(GraphService);
    edgeModel = moduleRef.get<Model<GraphEdgeDocument>>(getModelToken(GraphEdge.name));
    await syncAllIndexes(connection);
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await connection.collection('bot_nodes').deleteMany({});
    await connection.collection('bot_edges').deleteMany({});
  });

  describe('normalizeKey', () => {
    it('pasa a minúsculas y colapsa espacios', () => {
      expect(service.normalizeKey('  Solo   Leveling  ')).toBe('solo leveling');
    });

    it('quita acentos', () => {
      expect(service.normalizeKey('Canción de Amor')).toBe('cancion de amor');
    });

    it('devuelve cadena vacía para entrada inválida', () => {
      expect(service.normalizeKey('')).toBe('');
      expect(service.normalizeKey(null as never)).toBe('');
    });
  });

  describe('normalizeUserKey (Important #1 — identidad de usuario, separada de normalizeKey)', () => {
    it('pasa a minúsculas', () => {
      expect(service.normalizeUserKey('NICO')).toBe('nico');
    });

    it('recorta espacios en los bordes, pero NO colapsa espacios internos', () => {
      expect(service.normalizeUserKey('  Nico Bot  ')).toBe('nico bot');
      expect(service.normalizeUserKey('Nico  Bot')).toBe('nico  bot');
    });

    it('NO quita acentos — a diferencia de normalizeKey', () => {
      expect(service.normalizeUserKey('José')).toBe('josé');
      expect(service.normalizeUserKey('Jose')).toBe('jose');
      expect(service.normalizeUserKey('José')).not.toBe(service.normalizeUserKey('Jose'));
    });

    it('devuelve cadena vacía para entrada inválida', () => {
      expect(service.normalizeUserKey('')).toBe('');
      expect(service.normalizeUserKey(null as never)).toBe('');
    });
  });

  describe('identidad de nodos user vs. otros tipos (Important #1)', () => {
    it('upsertNode: "José" y "Jose" son nodos user DISTINTOS', async () => {
      const jose1 = await service.upsertNode({ type: 'user', key: 'José', label: 'José' });
      const jose2 = await service.upsertNode({ type: 'user', key: 'Jose', label: 'Jose' });

      expect(jose1!._id.toString()).not.toBe(jose2!._id.toString());
      const total = await connection.collection('bot_nodes').countDocuments({ type: 'user' });
      expect(total).toBe(2);
    });

    it('upsertNode: "Nico  Bot" (doble espacio) y "Nico Bot" son nodos user DISTINTOS', async () => {
      const a = await service.upsertNode({ type: 'user', key: 'Nico  Bot', label: 'Nico  Bot' });
      const b = await service.upsertNode({ type: 'user', key: 'Nico Bot', label: 'Nico Bot' });

      expect(a!._id.toString()).not.toBe(b!._id.toString());
    });

    it('upsertNode: "nico" y "NICO" siguen resolviendo al mismo nodo user', async () => {
      const a = await service.upsertNode({ type: 'user', key: 'nico', label: 'nico' });
      const b = await service.upsertNode({ type: 'user', key: 'NICO', label: 'NICO' });

      expect(a!._id.toString()).toBe(b!._id.toString());
    });

    it('findNode: resuelve un usuario por identidad exacta de acentos/espacios, no por normalizeKey', async () => {
      await service.upsertNode({ type: 'user', key: 'José', label: 'José' });
      await service.upsertNode({ type: 'user', key: 'Jose', label: 'Jose' });

      const conAcento = await service.findNode('user', 'José');
      const sinAcento = await service.findNode('user', 'Jose');

      expect(conAcento).not.toBeNull();
      expect(sinAcento).not.toBeNull();
      expect(conAcento!._id.toString()).not.toBe(sinAcento!._id.toString());
    });

    it('para tipos que no son user, sigue valiendo la insensibilidad a acentos de normalizeKey', async () => {
      const conAcento = await service.upsertNode({ type: 'work', key: 'Canción', label: 'Canción' });
      const sinAcento = await service.upsertNode({ type: 'work', key: 'Cancion', label: 'Cancion' });

      // Misma key normalizada ('cancion'): es el mismo nodo, no dos.
      expect(conAcento!._id.toString()).toBe(sinAcento!._id.toString());
    });
  });

  describe('upsertNode', () => {
    it('crea el nodo la primera vez con weight 1 al bumpear', async () => {
      const node = await service.upsertNode({
        type: 'work',
        key: 'anilist:105398',
        label: 'Solo Leveling',
        bumpWeight: true,
      });

      expect(node).not.toBeNull();
      expect(node!.weight).toBe(1);
      expect(node!.label).toBe('Solo Leveling');
    });

    it('no duplica: el segundo upsert incrementa el peso', async () => {
      await service.upsertNode({ type: 'work', key: 'anilist:105398', label: 'Solo Leveling', bumpWeight: true });
      const node = await service.upsertNode({ type: 'work', key: 'anilist:105398', label: 'Solo Leveling', bumpWeight: true });

      expect(node!.weight).toBe(2);
      const total = await connection.collection('bot_nodes').countDocuments({});
      expect(total).toBe(1);
    });

    it('no incrementa el peso cuando bumpWeight es falso', async () => {
      await service.upsertNode({ type: 'genre', key: 'action', label: 'Acción' });
      const node = await service.upsertNode({ type: 'genre', key: 'action', label: 'Acción' });

      expect(node!.weight).toBe(0);
    });

    it('acumula alias sin duplicarlos', async () => {
      await service.upsertNode({
        type: 'work', key: 'anilist:85143', label: 'Tower of God',
        aliases: ['tower of god', 'tog'],
      });
      const node = await service.upsertNode({
        type: 'work', key: 'anilist:85143', label: 'Tower of God',
        aliases: ['tog', 'el manhwa de la torre'],
      });

      expect(node!.aliases.sort()).toEqual(['el manhwa de la torre', 'tog', 'tower of god']);
    });

    it('fusiona props sin borrar las existentes', async () => {
      await service.upsertNode({
        type: 'work', key: 'anilist:105398', label: 'Solo Leveling',
        props: { score: 84, status: 'FINISHED' },
      });
      const node = await service.upsertNode({
        type: 'work', key: 'anilist:105398', label: 'Solo Leveling',
        props: { sinopsisEs: 'Un cazador débil...' },
      });

      expect(node!.props).toEqual({
        score: 84,
        status: 'FINISHED',
        sinopsisEs: 'Un cazador débil...',
      });
    });

    it('actualiza el label pero conserva la key', async () => {
      await service.upsertNode({ type: 'user', key: 'nico', label: 'nico' });
      const node = await service.upsertNode({ type: 'user', key: 'nico', label: 'Nico★' });

      expect(node!.key).toBe('nico');
      expect(node!.label).toBe('Nico★');
    });

    it('devuelve null si la key queda vacía tras normalizar', async () => {
      const node = await service.upsertNode({ type: 'topic', key: '   ', label: 'vacío' });
      expect(node).toBeNull();
    });
  });

  describe('resolveByAlias', () => {
    it('encuentra el nodo por alias exacto', async () => {
      await service.upsertNode({
        type: 'work', key: 'anilist:85143', label: 'Tower of God',
        aliases: ['el manhwa de la torre'],
      });

      const found = await service.resolveByAlias('El Manhwa De La Torre');
      expect(found!.label).toBe('Tower of God');
    });

    it('encuentra el nodo por su key normalizada', async () => {
      await service.upsertNode({ type: 'genre', key: 'action', label: 'Acción' });

      const found = await service.resolveByAlias('action');
      expect(found!.label).toBe('Acción');
    });

    it('desempata por peso cuando el alias es ambiguo', async () => {
      await service.upsertNode({ type: 'work', key: 'a', label: 'Obra A', aliases: ['torre'] });
      const b = await service.upsertNode({ type: 'work', key: 'b', label: 'Obra B', aliases: ['torre'], bumpWeight: true });
      expect(b!.weight).toBe(1);

      const found = await service.resolveByAlias('torre');
      expect(found!.label).toBe('Obra B');
    });

    it('filtra por tipo cuando se le pasan tipos', async () => {
      await service.upsertNode({ type: 'topic', key: 'romance', label: 'romance', aliases: ['romance'] });
      await service.upsertNode({ type: 'genre', key: 'romance-g', label: 'Romance', aliases: ['romance'] });

      const found = await service.resolveByAlias('romance', ['genre']);
      expect(found!.type).toBe('genre');
    });

    it('devuelve null cuando no hay match', async () => {
      expect(await service.resolveByAlias('no existe')).toBeNull();
    });
  });

  describe('resolveAnyAlias', () => {
    it('encuentra el nodo por uno de varios candidatos', async () => {
      await service.upsertNode({
        type: 'work', key: 'anilist:85143', label: 'Tower of God',
        aliases: ['tower of god', 'el manhwa de la torre'],
      });

      const found = await service.resolveAnyAlias(
        ['alguien sigue', 'sigue tower', 'tower of god', 'of god acaso'],
        ['work'],
      );
      expect(found!.label).toBe('Tower of God');
    });

    it('desempata por peso cuando varios candidatos matchean nodos distintos', async () => {
      await service.upsertNode({ type: 'work', key: 'a', label: 'Obra A', aliases: ['torre'] });
      const b = await service.upsertNode({ type: 'work', key: 'b', label: 'Obra B', aliases: ['monster'], bumpWeight: true });
      expect(b!.weight).toBe(1);

      const found = await service.resolveAnyAlias(['torre', 'monster']);
      expect(found!.label).toBe('Obra B');
    });

    it('devuelve null si ningún candidato matchea', async () => {
      await service.upsertNode({ type: 'work', key: 'a', label: 'Obra A', aliases: ['torre'] });

      expect(await service.resolveAnyAlias(['no existe', 'tampoco esto'])).toBeNull();
    });

    it('devuelve null con una lista vacía de candidatos', async () => {
      await service.upsertNode({ type: 'work', key: 'a', label: 'Obra A', aliases: ['torre'] });

      expect(await service.resolveAnyAlias([])).toBeNull();
    });
  });

  describe('upsertEdge y topEdges', () => {
    it('crea la arista con peso 1 y la repetición la sube a 2', async () => {
      const nico = await service.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      const sl = await service.upsertNode({ type: 'work', key: 'anilist:105398', label: 'Solo Leveling' });

      await service.upsertEdge({ from: nico!._id, to: sl!._id, type: 'likes', source: 'fact' });
      await service.upsertEdge({ from: nico!._id, to: sl!._id, type: 'likes', source: 'fact' });

      const edges = await connection.collection('bot_edges').find({}).toArray();
      expect(edges).toHaveLength(1);
      expect(edges[0].weight).toBe(2);
    });

    it('conserva el source original al repetirse', async () => {
      const nico = await service.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      const sl = await service.upsertNode({ type: 'work', key: 'anilist:105398', label: 'Solo Leveling' });

      await service.upsertEdge({ from: nico!._id, to: sl!._id, type: 'likes', source: 'signal' });
      await service.upsertEdge({ from: nico!._id, to: sl!._id, type: 'likes', source: 'batch' });

      const edge = await connection.collection('bot_edges').findOne({});
      expect(edge!.source).toBe('signal');
    });

    it('no escribe nada si from y to son el mismo nodo', async () => {
      const nico = await service.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });

      await service.upsertEdge({ from: nico!._id, to: nico!._id, type: 'interacts_with', source: 'signal' });

      const total = await connection.collection('bot_edges').countDocuments({});
      expect(total).toBe(0);
    });

    it('topEdges devuelve las de mayor peso primero, con el label del destino', async () => {
      const nico = await service.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      const sl = await service.upsertNode({ type: 'work', key: 'a', label: 'Solo Leveling' });
      const tog = await service.upsertNode({ type: 'work', key: 'b', label: 'Tower of God' });

      await service.upsertEdge({ from: nico!._id, to: sl!._id, type: 'likes', source: 'fact' });
      await service.upsertEdge({ from: nico!._id, to: tog!._id, type: 'likes', source: 'fact' });
      await service.upsertEdge({ from: nico!._id, to: tog!._id, type: 'likes', source: 'fact' });

      const top = await service.topEdges(nico!._id, ['likes'], 10);

      expect(top).toHaveLength(2);
      expect(top[0].label).toBe('Tower of God');
      expect(top[0].weight).toBe(2);
      expect(top[0].nodeType).toBe('work');
      expect(top[1].label).toBe('Solo Leveling');
    });

    it('topEdges filtra por tipo de arista', async () => {
      const nico = await service.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      const sl = await service.upsertNode({ type: 'work', key: 'a', label: 'Solo Leveling' });

      await service.upsertEdge({ from: nico!._id, to: sl!._id, type: 'likes', source: 'fact' });
      await service.upsertEdge({ from: nico!._id, to: sl!._id, type: 'asked_about', source: 'signal' });

      const top = await service.topEdges(nico!._id, ['asked_about'], 10);
      expect(top).toHaveLength(1);
      expect(top[0].type).toBe('asked_about');
    });

    it('topEdges respeta el límite', async () => {
      const nico = await service.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      for (let i = 0; i < 5; i++) {
        const w = await service.upsertNode({ type: 'work', key: `w${i}`, label: `Obra ${i}` });
        await service.upsertEdge({ from: nico!._id, to: w!._id, type: 'likes', source: 'fact' });
      }

      const top = await service.topEdges(nico!._id, ['likes'], 3);
      expect(top).toHaveLength(3);
    });

    it('topEdges devuelve vacío para un nodo sin aristas', async () => {
      const solo = await service.upsertNode({ type: 'user', key: 'solo', label: 'Solo' });
      expect(await service.topEdges(solo!._id, ['likes'], 10)).toEqual([]);
    });
  });

  describe('recentEdges', () => {
    it('ordena por lastSeenAt descendente, no por weight', async () => {
      const nico = await service.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      const a = await service.upsertNode({ type: 'work', key: 'a', label: 'Obra A' });
      const b = await service.upsertNode({ type: 'work', key: 'b', label: 'Obra B' });

      await service.upsertEdge({ from: nico!._id, to: a!._id, type: 'asked_about', source: 'signal' });
      await connection.collection('bot_edges').updateOne(
        { from: nico!._id, to: a!._id, type: 'asked_about' },
        { $set: { lastSeenAt: new Date(Date.now() - 60_000) } },
      );
      await service.upsertEdge({ from: nico!._id, to: b!._id, type: 'asked_about', source: 'signal' });

      const rows = await service.recentEdges(nico!._id, ['asked_about'], 5 * 60 * 1000, 10);
      expect(rows).toHaveLength(2);
      expect(rows[0].label).toBe('Obra B'); // la más reciente, primero
      expect(rows[1].label).toBe('Obra A');
    });

    it('excluye aristas fuera de la ventana de sinceMs', async () => {
      const nico = await service.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      const vieja = await service.upsertNode({ type: 'work', key: 'vieja', label: 'Vieja' });
      await service.upsertEdge({ from: nico!._id, to: vieja!._id, type: 'asked_about', source: 'signal' });
      await connection.collection('bot_edges').updateOne(
        { from: nico!._id, to: vieja!._id, type: 'asked_about' },
        { $set: { lastSeenAt: new Date(Date.now() - 20 * 60 * 1000) } },
      );

      expect(await service.recentEdges(nico!._id, ['asked_about'], 10 * 60 * 1000, 10)).toEqual([]);
    });

    it('prioriza recencia sobre peso — a diferencia de topEdges', async () => {
      const nico = await service.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      const heavy = await service.upsertNode({ type: 'work', key: 'heavy', label: 'Pesada' });
      const light = await service.upsertNode({ type: 'work', key: 'light', label: 'Liviana' });

      for (let i = 0; i < 5; i++) {
        await service.upsertEdge({ from: nico!._id, to: heavy!._id, type: 'asked_about', source: 'signal' });
      }
      await connection.collection('bot_edges').updateOne(
        { from: nico!._id, to: heavy!._id, type: 'asked_about' },
        { $set: { lastSeenAt: new Date(Date.now() - 5 * 60 * 1000) } },
      );
      await service.upsertEdge({ from: nico!._id, to: light!._id, type: 'asked_about', source: 'signal' });

      const [top] = await service.recentEdges(nico!._id, ['asked_about'], 10 * 60 * 1000, 1);
      expect(top.label).toBe('Liviana');
    });

    it('devuelve vacío con una lista de tipos vacía o un límite <= 0', async () => {
      const nico = await service.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      expect(await service.recentEdges(nico!._id, [], 60_000, 10)).toEqual([]);
      expect(await service.recentEdges(nico!._id, ['asked_about'], 60_000, 0)).toEqual([]);
    });
  });

  describe('collaborative (Task 3, fase 5b — recomendación colaborativa)', () => {
    /** Le pone `likes` de `user` hacia un nodo `label` (`work` por default), sembrando ambos nodos. */
    const gusta = async (user: string, label: string, type: 'work' | 'topic' | 'genre' | 'artist' = 'work') => {
      const u = await service.upsertNode({ type: 'user', key: user, label: user });
      const w = await service.upsertNode({ type, key: label, label });
      await service.upsertEdge({ from: u!._id, to: w!._id, type: 'likes', source: 'fact' });
      return { u: u!, w: w! };
    };

    it('devuelve vacío cuando el usuario no tiene gustos', async () => {
      const nico = await service.upsertNode({ type: 'user', key: 'Nico', label: 'Nico' });
      expect(await service.collaborative(nico!._id, 5)).toEqual([]);
    });

    it('devuelve vacío cuando nadie más comparte sus gustos', async () => {
      const { u } = await gusta('Nico', 'Berserk');
      // Kei existe en el grafo, pero le gusta algo sin ninguna superposición con Nico.
      await gusta('Kei', 'One Piece');

      expect(await service.collaborative(u._id, 5)).toEqual([]);
    });

    it('encuentra lo que le gusta a quienes comparten un gusto con él', async () => {
      const { u } = await gusta('Nico', 'Berserk');
      const { u: kei } = await gusta('Kei', 'Berserk');
      const orv = await service.upsertNode({ type: 'work', key: 'ORV', label: 'ORV' });
      await service.upsertEdge({ from: kei._id, to: orv!._id, type: 'likes', source: 'fact' });

      const result = await service.collaborative(u._id, 5);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ key: 'orv', label: 'ORV', score: 1 });
    });

    it('NO devuelve obras que al usuario ya le gustan', async () => {
      const { u } = await gusta('Nico', 'Berserk');
      const orv = await service.upsertNode({ type: 'work', key: 'ORV', label: 'ORV' });
      await service.upsertEdge({ from: u._id, to: orv!._id, type: 'likes', source: 'fact' });

      const { u: kei } = await gusta('Kei', 'Berserk');
      await service.upsertEdge({ from: kei._id, to: orv!._id, type: 'likes', source: 'fact' });

      const result = await service.collaborative(u._id, 5);

      // ORV es justo lo que Nico y Kei tienen en común -- ya le gusta a Nico,
      // así que no tiene sentido "recomendársela" de vuelta.
      expect(result.find((c) => c.key === 'orv')).toBeUndefined();
    });

    it('NO devuelve obras que ya se le recomendaron', async () => {
      const { u } = await gusta('Nico', 'Berserk');
      const orv = await service.upsertNode({ type: 'work', key: 'ORV', label: 'ORV' });
      await service.upsertEdge({ from: u._id, to: orv!._id, type: 'recommended_to', source: 'signal' });

      const { u: kei } = await gusta('Kei', 'Berserk');
      await service.upsertEdge({ from: kei._id, to: orv!._id, type: 'likes', source: 'fact' });

      const result = await service.collaborative(u._id, 5);

      expect(result.find((c) => c.key === 'orv')).toBeUndefined();
    });

    it('NO devuelve nodos que no sean de tipo work (ni topic, ni genre, ni artist)', async () => {
      const { u } = await gusta('Nico', 'Berserk');
      const { u: kei } = await gusta('Kei', 'Berserk');

      const orv = await service.upsertNode({ type: 'work', key: 'ORV', label: 'ORV' });
      // Un `likes` a un `topic` es exactamente lo que deja un hecho de texto
      // libre sin resolver (ver `GraphIngestService.ingestFact`) -- p. ej.
      // "tiene 25 años". Si el recorrido lo alcanzara, el bot lo "recomendaría".
      const topic = await service.upsertNode({ type: 'topic', key: 'tiene 25 años', label: 'tiene 25 años' });
      const genre = await service.upsertNode({ type: 'genre', key: 'accion', label: 'Acción' });
      const artist = await service.upsertNode({ type: 'artist', key: 'hiroya oku', label: 'Hiroya Oku' });

      await service.upsertEdge({ from: kei._id, to: orv!._id, type: 'likes', source: 'fact' });
      await service.upsertEdge({ from: kei._id, to: topic!._id, type: 'likes', source: 'fact' });
      await service.upsertEdge({ from: kei._id, to: genre!._id, type: 'likes', source: 'fact' });
      await service.upsertEdge({ from: kei._id, to: artist!._id, type: 'likes', source: 'fact' });

      const result = await service.collaborative(u._id, 10);

      // La única obra real (`type: 'work'`) que Kei comparte además de
      // Berserk es ORV -- es lo único que debería aparecer.
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('orv');
      // Esta es la aserción que detecta que el filtro por tipo se sacó de la
      // agregación: sin él, cualquiera de estos tres aparecería también.
      expect(result.some((c) => c.label === topic!.label)).toBe(false);
      expect(result.some((c) => c.label === genre!.label)).toBe(false);
      expect(result.some((c) => c.label === artist!.label)).toBe(false);
    });

    it('suma el peso cuando varias personas coinciden, y ordena por eso', async () => {
      const { u } = await gusta('Nico', 'Berserk');
      const popular = await service.upsertNode({ type: 'work', key: 'Popular', label: 'Candidata Popular' });
      const solitaria = await service.upsertNode({ type: 'work', key: 'Solitaria', label: 'Candidata Solitaria' });

      const { u: kei } = await gusta('Kei', 'Berserk');
      const { u: rin } = await gusta('Rin', 'Berserk');
      const { u: mel } = await gusta('Mel', 'Berserk');

      await service.upsertEdge({ from: kei._id, to: popular!._id, type: 'likes', source: 'fact' });
      await service.upsertEdge({ from: rin._id, to: popular!._id, type: 'likes', source: 'fact' });
      await service.upsertEdge({ from: mel._id, to: solitaria!._id, type: 'likes', source: 'fact' });

      const result = await service.collaborative(u._id, 5);

      expect(result[0].key).toBe('popular');
      expect(result[0].score).toBe(2);
      expect(result[1].key).toBe('solitaria');
      expect(result[1].score).toBe(1);
    });

    it('respeta el límite', async () => {
      const { u } = await gusta('Nico', 'Berserk');
      const { u: kei } = await gusta('Kei', 'Berserk');
      for (let i = 0; i < 8; i++) {
        const w = await service.upsertNode({ type: 'work', key: `w${i}`, label: `Obra ${i}` });
        await service.upsertEdge({ from: kei._id, to: w!._id, type: 'likes', source: 'fact' });
      }

      expect(await service.collaborative(u._id, 3)).toHaveLength(3);
    });

    it('acota los pares a MAX_PEERS, priorizando a quienes más fuerte comparten el gusto (ronda de corrección 1)', async () => {
      // Sembrado por escritura directa a la colección (no vía upsertNode/
      // upsertEdge, uno por uno) porque son cientos de documentos -- lo que
      // importa acá es el volumen y los pesos exactos, no ejercitar el
      // upsert en sí (ya cubierto por otros tests de este archivo).
      const nico = await service.upsertNode({ type: 'user', key: 'Nico', label: 'Nico' });
      const berserk = await service.upsertNode({ type: 'work', key: 'Berserk', label: 'Berserk' });
      await service.upsertEdge({ from: nico!._id, to: berserk!._id, type: 'likes', source: 'fact' });

      const total = MAX_PEERS + 20;
      const now = new Date();
      const peerNodes = Array.from({ length: total }, (_, i) => ({
        _id: new Types.ObjectId(),
        type: 'user',
        key: `peer${i}`,
        label: `peer${i}`,
        aliases: [],
        props: {},
        weight: 0,
        lastSeenAt: now,
      }));
      const candNodes = Array.from({ length: total }, (_, i) => ({
        _id: new Types.ObjectId(),
        type: 'work',
        key: `cand${i}`,
        label: `Candidata ${i}`,
        aliases: [],
        props: {},
        weight: 0,
        lastSeenAt: now,
      }));
      await connection.collection('bot_nodes').insertMany([...peerNodes, ...candNodes]);

      // El peer `i` comparte el gusto por Berserk con un peso creciente
      // (i + 1): el último peer (índice `total - 1`) es el que MÁS fuerte
      // lo comparte, y por eso debería sobrevivir al tope.
      const anchorEdges = peerNodes.map((p, i) => ({
        from: p._id,
        to: berserk!._id,
        type: 'likes',
        weight: i + 1,
        source: 'fact',
        lastSeenAt: now,
      }));
      // Cada peer recomienda una candidata propia y distinta -- así el
      // conteo final de candidatas devueltas mide directamente cuántos
      // pares sobrevivieron al tope.
      const candidateEdges = peerNodes.map((p, i) => ({
        from: p._id,
        to: candNodes[i]._id,
        type: 'likes',
        weight: 1,
        source: 'fact',
        lastSeenAt: now,
      }));
      await connection.collection('bot_edges').insertMany([...anchorEdges, ...candidateEdges]);

      const result = await service.collaborative(nico!._id, total);

      // El tope de MAX_PEERS pares termina limitando, en los hechos, a
      // MAX_PEERS candidatas -- aunque el `limit` pedido (total) sea mucho
      // mayor y daría lugar a más si no hubiera tope de pares.
      expect(result).toHaveLength(MAX_PEERS);
      // Los peers de MENOS peso (índices bajos) quedaron afuera del tope...
      expect(result.find((c) => c.key === 'cand0')).toBeUndefined();
      expect(result.find((c) => c.key === 'cand19')).toBeUndefined();
      // ...los de MÁS peso (índices altos) sí entraron: el recorte prioriza,
      // no es un corte arbitrario de los primeros que aparezcan.
      expect(result.find((c) => c.key === `cand${total - 1}`)).toBeDefined();
      expect(result.find((c) => c.key === 'cand20')).toBeDefined();
    }, 20000);

    it('no cuenta al propio usuario como "otro"', async () => {
      // Nico es el ÚNICO conectado a Berserk -- nadie más comparte el gusto.
      // Si el propio usuario se contara como "otro" que comparte el gusto,
      // el recorrido seguiría con los `likes` DEL PROPIO NICO como si
      // vinieran de un tercero -- pero esos mismos `likes` son justo lo que
      // la regla "no devuelve obras que ya le gustan" excluye de las
      // candidatas, así que el resultado queda vacío en ambos casos. El
      // test documenta la garantía igual: protege contra una regresión que
      // rompa esa otra regla al mismo tiempo (ver el reporte de esta tarea
      // para la comprobación de reversión de este caso puntual).
      const { u } = await gusta('Nico', 'Berserk');
      const otraObra = await service.upsertNode({ type: 'work', key: 'Vinland Saga', label: 'Vinland Saga' });
      await service.upsertEdge({ from: u._id, to: otraObra!._id, type: 'likes', source: 'fact' });

      expect(await service.collaborative(u._id, 5)).toEqual([]);
    });

    it('no lanza cuando el grafo falla', async () => {
      const { u } = await gusta('Nico', 'Berserk');
      jest
        .spyOn(edgeModel, 'aggregate')
        .mockReturnValueOnce({ exec: () => Promise.reject(new Error('mongo caído')) } as never);

      await expect(service.collaborative(u._id, 5)).resolves.toEqual([]);
    });
  });
});
