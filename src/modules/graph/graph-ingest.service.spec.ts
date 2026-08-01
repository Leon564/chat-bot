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
});
