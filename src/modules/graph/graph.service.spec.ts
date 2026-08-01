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

describe('GraphService — nodos', () => {
  let connection: Connection;
  let service: GraphService;

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
});
