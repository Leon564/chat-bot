import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import {
  rootMongooseTestModule,
  closeMongoConnection,
  syncAllIndexes,
} from '../../common/testing/mongo-test.helper';
import { GraphNode, GraphNodeSchema } from '../../common/schemas/graph-node.schema';
import { GraphEdge, GraphEdgeSchema } from '../../common/schemas/graph-edge.schema';
import { Errand, ErrandSchema, ErrandDocument } from '../../common/schemas/errand.schema';
import { GraphService } from './graph.service';
import {
  ErrandService,
  MAX_PENDING_PER_AUTHOR,
  MAX_PENDING_PER_TARGET,
  MAX_ERRAND_TEXT,
} from './errand.service';

describe('ErrandService', () => {
  let connection: Connection;
  let service: ErrandService;
  let graph: GraphService;
  let model: Model<ErrandDocument>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([
          { name: GraphNode.name, schema: GraphNodeSchema },
          { name: GraphEdge.name, schema: GraphEdgeSchema },
          { name: Errand.name, schema: ErrandSchema },
        ]),
      ],
      providers: [GraphService, ErrandService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    service = moduleRef.get<ErrandService>(ErrandService);
    graph = moduleRef.get<GraphService>(GraphService);
    model = moduleRef.get<Model<ErrandDocument>>(getModelToken(Errand.name));
    await syncAllIndexes(connection);
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await connection.collection('bot_nodes').deleteMany({});
    await connection.collection('bot_edges').deleteMany({});
    await connection.collection('bot_errands').deleteMany({});
  });

  beforeEach(async () => {
    await graph.upsertNode({ type: 'user', key: 'leon', label: 'leon' });
    await graph.upsertNode({ type: 'user', key: 'lyna', label: 'Lyna' });
  });

  it('crea un recado para un usuario conocido', async () => {
    expect(await service.create('leon', 'lyna', 'que suba el video')).toBe('ok');
  });

  it('rechaza un destinatario que no existe', async () => {
    expect(await service.create('leon', 'fantasma', 'hola')).toBe('usuario_desconocido');
  });

  it('rechaza un texto vacío o demasiado largo', async () => {
    expect(await service.create('leon', 'lyna', '  ')).toBe('invalido');
    expect(await service.create('leon', 'lyna', 'x'.repeat(MAX_ERRAND_TEXT + 1))).toBe('invalido');
  });

  it('frena en el tope por autor, contando las activaciones', async () => {
    const resultados: string[] = [];
    for (let i = 0; i < MAX_PENDING_PER_AUTHOR + 2; i++) {
      resultados.push(await service.create('leon', 'lyna', `recado ${i}`));
    }
    expect(resultados.filter((r) => r === 'ok')).toHaveLength(MAX_PENDING_PER_AUTHOR);
    expect(resultados.filter((r) => r === 'autor_lleno')).toHaveLength(2);
  });

  it('el tope por autor es GLOBAL, no por destinatario', async () => {
    await graph.upsertNode({ type: 'user', key: 'ash', label: 'ash' });
    for (let i = 0; i < MAX_PENDING_PER_AUTHOR; i++) {
      expect(await service.create('leon', 'lyna', `r${i}`)).toBe('ok');
    }
    // Otro destinatario NO le renueva el cupo.
    expect(await service.create('leon', 'ash', 'otro')).toBe('autor_lleno');
  });

  it('frena en el tope por destinatario sumando autores distintos', async () => {
    for (let i = 0; i < MAX_PENDING_PER_TARGET + 1; i++) {
      const autor = `autor${i}`;
      await graph.upsertNode({ type: 'user', key: autor, label: autor });
      const r = await service.create(autor, 'lyna', `r${i}`);
      if (i < MAX_PENDING_PER_TARGET) expect(r).toBe('ok');
      else expect(r).toBe('destino_lleno');
    }
  });

  it('claimNext devuelve el más viejo y lo marca entregado', async () => {
    await service.create('leon', 'lyna', 'primero');
    await service.create('leon', 'lyna', 'segundo');

    const uno = await service.claimNext('lyna');
    const dos = await service.claimNext('lyna');
    const tres = await service.claimNext('lyna');

    expect(uno?.text).toBe('primero');
    expect(dos?.text).toBe('segundo');
    expect(tres).toBeNull();
  });

  it('claimNext devuelve el nombre mostrable del autor', async () => {
    await graph.upsertNode({ type: 'user', key: 'josé', label: 'José' });
    await service.create('José', 'lyna', 'hola');

    expect((await service.claimNext('lyna'))?.fromLabel).toBe('José');
  });

  it('no entrega un recado vencido', async () => {
    await service.create('leon', 'lyna', 'viejo');
    await model.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await service.claimNext('lyna')).toBeNull();
  });

  it('un recado vencido no ocupa cupo del autor', async () => {
    for (let i = 0; i < MAX_PENDING_PER_AUTHOR; i++) await service.create('leon', 'lyna', `r${i}`);
    await model.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await service.create('leon', 'lyna', 'nuevo')).toBe('ok');
  });

  it('dos claimNext concurrentes no entregan el mismo recado', async () => {
    await service.create('leon', 'lyna', 'único');

    const [a, b] = await Promise.all([service.claimNext('lyna'), service.claimNext('lyna')]);

    // Exactamente uno gana. Esto se verifica CONTANDO, no leyendo la condición:
    // sin el findOneAndUpdate atómico, los dos leen el mismo documento pendiente.
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});
