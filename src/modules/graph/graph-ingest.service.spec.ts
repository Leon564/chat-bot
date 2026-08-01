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
import { GraphIngestService } from './graph-ingest.service';
import { ChatMessage } from '../chat-socket/chat-socket.service';

const baseMsg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  _id: 'm1',
  content: 'hola',
  authorUsername: 'Nico',
  type: 'text',
  createdAt: new Date().toISOString(),
  ...over,
});

describe('GraphIngestService — señales sociales', () => {
  let connection: Connection;
  let ingest: GraphIngestService;
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
      providers: [GraphService, GraphIngestService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    ingest = moduleRef.get<GraphIngestService>(GraphIngestService);
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

  it('crea el nodo del autor con su label original', async () => {
    await ingest.ingestSocial(baseMsg({ authorUsername: 'Sleepy Ash' }));

    const node = await graph.findNode('user', 'sleepy ash');
    expect(node).not.toBeNull();
    expect(node!.label).toBe('Sleepy Ash');
  });

  it('crea aristas interacts_with en ambos sentidos por una mención', async () => {
    await ingest.ingestSocial(baseMsg({ authorUsername: 'Nico', content: 'ey <@kei> mirá esto' }));

    const nico = await graph.findNode('user', 'nico');
    const kei = await graph.findNode('user', 'kei');
    expect(kei).not.toBeNull();

    const ida = await graph.topEdges(nico!._id, ['interacts_with'], 10);
    const vuelta = await graph.topEdges(kei!._id, ['interacts_with'], 10);
    expect(ida[0].label).toBe('kei');
    expect(vuelta[0].label).toBe('Nico');
  });

  it('cuenta varias menciones en un mismo mensaje', async () => {
    await ingest.ingestSocial(baseMsg({ content: '<@kei> y <@Lyna> vengan' }));

    const nico = await graph.findNode('user', 'nico');
    const top = await graph.topEdges(nico!._id, ['interacts_with'], 10);
    expect(top.map((t) => t.label).sort()).toEqual(['Lyna', 'kei']);
  });

  it('refuerza la arista cuando la interacción se repite', async () => {
    await ingest.ingestSocial(baseMsg({ content: '<@kei> hola' }));
    await ingest.ingestSocial(baseMsg({ content: '<@kei> otra vez' }));

    const nico = await graph.findNode('user', 'nico');
    const top = await graph.topEdges(nico!._id, ['interacts_with'], 10);
    expect(top).toHaveLength(1);
    expect(top[0].weight).toBe(2);
  });

  it('cuenta el replyTo como interacción', async () => {
    await ingest.ingestSocial(
      baseMsg({
        content: 'de acuerdo',
        replyTo: { messageId: 'x', authorUsername: 'kei', authorColor: '#fff', contentExcerpt: '...' },
      }),
    );

    const nico = await graph.findNode('user', 'nico');
    const top = await graph.topEdges(nico!._id, ['interacts_with'], 10);
    expect(top[0].label).toBe('kei');
  });

  it('ignora la auto-mención', async () => {
    await ingest.ingestSocial(baseMsg({ authorUsername: 'Nico', content: 'yo <@Nico> soy' }));

    const total = await connection.collection('bot_edges').countDocuments({});
    expect(total).toBe(0);
  });

  it('ignora mensajes de stickers para las menciones', async () => {
    await ingest.ingestSocial(baseMsg({ type: 'sticker', content: '<@kei>' }));

    const total = await connection.collection('bot_edges').countDocuments({});
    expect(total).toBe(0);
  });

  it('no lanza cuando el autor viene vacío', async () => {
    await expect(ingest.ingestSocial(baseMsg({ authorUsername: '' }))).resolves.toBeUndefined();
  });

  describe('ingesta de AniList', () => {
    const result = {
      id: 105398,
      url: 'https://anilist.co/manga/105398',
      kind: 'manhwa' as const,
      titleRomaji: 'Na Honjaman Level Up',
      titleEnglish: 'Solo Leveling',
      coverImage: 'https://img/cover.jpg',
      bannerImage: null,
      score: 84,
      status: 'FINISHED',
      chapters: 179,
      volumes: null,
      episodes: null,
      genres: ['Action', 'Adventure', 'Fantasy'],
      description: 'Un cazador débil...',
      startYear: 2018,
    };

    it('crea el nodo work con key anilist:<id> y la ficha en props', async () => {
      await ingest.ingestAniList('Nico', result, 'solo leveling');

      const node = await graph.findNode('work', 'anilist:105398');
      expect(node).not.toBeNull();
      expect(node!.label).toBe('Solo Leveling');
      expect(node!.props.score).toBe(84);
      expect(node!.props.status).toBe('FINISHED');
      expect(node!.props.chapters).toBe(179);
      expect(node!.props.cachedAt).toBeDefined();
    });

    it('usa titleRomaji como label cuando no hay inglés', async () => {
      await ingest.ingestAniList('Nico', { ...result, titleEnglish: null }, 'x');

      const node = await graph.findNode('work', 'anilist:105398');
      expect(node!.label).toBe('Na Honjaman Level Up');
    });

    it('guarda como alias ambos títulos y la query original', async () => {
      await ingest.ingestAniList('Nico', result, 'el manhwa del cazador débil');

      const node = await graph.findNode('work', 'anilist:105398');
      expect(node!.aliases).toContain('solo leveling');
      expect(node!.aliases).toContain('na honjaman level up');
      expect(node!.aliases).toContain('el manhwa del cazador debil');
    });

    it('crea la arista asked_about desde el usuario', async () => {
      await ingest.ingestAniList('Nico', result, 'x');

      const nico = await graph.findNode('user', 'nico');
      const top = await graph.topEdges(nico!._id, ['asked_about'], 10);
      expect(top[0].label).toBe('Solo Leveling');
    });

    it('crea un nodo genre y una arista has_genre por CADA género', async () => {
      await ingest.ingestAniList('Nico', result, 'x');

      const work = await graph.findNode('work', 'anilist:105398');
      const generos = await graph.topEdges(work!._id, ['has_genre'], 10);
      expect(generos.map((g) => g.label).sort()).toEqual(['Acción', 'Aventura', 'Fantasía']);
    });

    it('deja el género en inglés si no está en el mapa de traducción', async () => {
      await ingest.ingestAniList('Nico', { ...result, genres: ['Isekai'] }, 'x');

      const work = await graph.findNode('work', 'anilist:105398');
      const generos = await graph.topEdges(work!._id, ['has_genre'], 10);
      expect(generos[0].label).toBe('Isekai');
    });

    it('es idempotente: dos consultas no duplican nodos ni aristas', async () => {
      await ingest.ingestAniList('Nico', result, 'solo leveling');
      await ingest.ingestAniList('Nico', result, 'solo leveling');

      const works = await connection.collection('bot_nodes').countDocuments({ type: 'work' });
      const generos = await connection.collection('bot_nodes').countDocuments({ type: 'genre' });
      expect(works).toBe(1);
      expect(generos).toBe(3);

      const nico = await graph.findNode('user', 'nico');
      const top = await graph.topEdges(nico!._id, ['asked_about'], 10);
      expect(top[0].weight).toBe(2);
    });
  });
});
