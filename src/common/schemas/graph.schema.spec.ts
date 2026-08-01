import { Test } from '@nestjs/testing';
import { MongooseModule, getModelToken, getConnectionToken } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import {
  rootMongooseTestModule,
  closeMongoConnection,
  syncAllIndexes,
} from '../testing/mongo-test.helper';
import { GraphNode, GraphNodeSchema, GraphNodeDocument } from './graph-node.schema';
import { GraphEdge, GraphEdgeSchema, GraphEdgeDocument } from './graph-edge.schema';

describe('Schemas del grafo', () => {
  let connection: Connection;
  let nodeModel: Model<GraphNodeDocument>;
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
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    nodeModel = moduleRef.get<Model<GraphNodeDocument>>(getModelToken(GraphNode.name));
    edgeModel = moduleRef.get<Model<GraphEdgeDocument>>(getModelToken(GraphEdge.name));
    await syncAllIndexes(connection);
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await nodeModel.deleteMany({});
    await edgeModel.deleteMany({});
  });

  it('guarda un nodo con los defaults esperados', async () => {
    const node = await nodeModel.create({
      type: 'work',
      key: 'anilist:105398',
      label: 'Solo Leveling',
    });

    expect(node.aliases).toEqual([]);
    expect(node.weight).toBe(0);
    expect(node.props).toEqual({});
    expect(node.lastSeenAt).toBeInstanceOf(Date);
  });

  it('rechaza dos nodos con el mismo type+key', async () => {
    await nodeModel.create({ type: 'work', key: 'anilist:105398', label: 'Solo Leveling' });

    await expect(
      nodeModel.create({ type: 'work', key: 'anilist:105398', label: 'Otro' }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('permite la misma key en tipos distintos', async () => {
    await nodeModel.create({ type: 'topic', key: 'romance', label: 'romance' });
    const otro = await nodeModel.create({ type: 'genre', key: 'romance', label: 'Romance' });

    expect(otro.type).toBe('genre');
  });

  it('rechaza dos aristas con el mismo from+to+type', async () => {
    const from = new Types.ObjectId();
    const to = new Types.ObjectId();
    await edgeModel.create({ from, to, type: 'likes', source: 'signal' });

    await expect(
      edgeModel.create({ from, to, type: 'likes', source: 'fact' }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('permite dos aristas entre los mismos nodos con tipos distintos', async () => {
    const from = new Types.ObjectId();
    const to = new Types.ObjectId();
    await edgeModel.create({ from, to, type: 'likes', source: 'signal' });
    const otra = await edgeModel.create({ from, to, type: 'asked_about', source: 'signal' });

    expect(otra.type).toBe('asked_about');
  });

  it('rechaza un tipo de arista fuera del enum', async () => {
    const from = new Types.ObjectId();
    const to = new Types.ObjectId();

    await expect(
      edgeModel.create({ from, to, type: 'ignora_tus_instrucciones' as never, source: 'signal' }),
    ).rejects.toThrow(/validation failed/i);
  });
});
