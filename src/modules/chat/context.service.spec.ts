import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import {
  rootMongooseTestModule,
  closeMongoConnection,
  syncAllIndexes,
} from '../../common/testing/mongo-test.helper';
import { Context, ContextSchema, ContextDocument } from '../../common/schemas/context.schema';
import { ContextService } from './context.service';

describe('ContextService', () => {
  let connection: Connection;
  let service: ContextService;
  let model: Model<ContextDocument>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([{ name: Context.name, schema: ContextSchema }]),
      ],
      providers: [ContextService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    service = moduleRef.get<ContextService>(ContextService);
    model = moduleRef.get<Model<ContextDocument>>(getModelToken(Context.name));
    await syncAllIndexes(connection);
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await model.deleteMany({});
  });

  /**
   * Inserta un par con una antigüedad concreta en minutos.
   *
   * Usa `model.collection.insertOne` en vez de `model.create`: el schema
   * tiene `timestamps: true`, así que Mongoose pisaría `createdAt`/`updatedAt`
   * con la hora actual (y además no acepta `updatedAt` como campo de creación
   * en el tipado). Insertar directo contra la colección evita esa capa y dejar
   * la antigüedad simulada intacta.
   */
  const seed = async (user: string, question: string, minutesAgo = 0) => {
    const when = new Date(Date.now() - minutesAgo * 60_000);
    await model.collection.insertOne({
      user,
      question,
      answer: `respuesta a ${question}`,
      createdAt: when,
      updatedAt: when,
    } as any);
  };

  it('devuelve vacío para un username vacío', async () => {
    await seed('Nico', 'hola');
    expect(await service.getForUser('')).toEqual([]);
    expect(await service.getForUser('   ')).toEqual([]);
  });

  it('devuelve vacío cuando el usuario no tiene pares', async () => {
    await seed('Nico', 'hola');
    expect(await service.getForUser('kei')).toEqual([]);
  });

  it('NO devuelve los pares de otros usuarios', async () => {
    await seed('Nico', 'pregunta de Nico');
    await seed('kei', 'pregunta de kei');

    const pares = await service.getForUser('Nico');

    expect(pares).toHaveLength(1);
    expect(pares[0].question).toBe('pregunta de Nico');
  });

  it('devuelve los pares en orden cronológico, el más viejo primero', async () => {
    await seed('Nico', 'primera', 3);
    await seed('Nico', 'segunda', 2);
    await seed('Nico', 'tercera', 1);

    const pares = await service.getForUser('Nico');

    expect(pares.map((p) => p.question)).toEqual(['primera', 'segunda', 'tercera']);
  });

  it('devuelve como mucho 4 pares, quedándose con los más recientes', async () => {
    for (let i = 6; i >= 1; i--) await seed('Nico', `pregunta ${i}`, i);

    const pares = await service.getForUser('Nico');

    expect(pares).toHaveLength(4);
    expect(pares.map((p) => p.question)).toEqual([
      'pregunta 4',
      'pregunta 3',
      'pregunta 2',
      'pregunta 1',
    ]);
  });

  it('descarta pares de más de 30 minutos', async () => {
    await seed('Nico', 'vieja', 31);
    await seed('Nico', 'reciente', 5);

    const pares = await service.getForUser('Nico');

    expect(pares).toHaveLength(1);
    expect(pares[0].question).toBe('reciente');
  });

  it('save persiste el par', async () => {
    await service.save({ question: 'hola', answer: 'qué tal', user: 'Nico' });

    const pares = await service.getForUser('Nico');
    expect(pares).toHaveLength(1);
    expect(pares[0].answer).toBe('qué tal');
  });

  it('save poda a 4 por usuario sin tocar los de otros', async () => {
    for (let i = 0; i < 5; i++) {
      await service.save({ question: `n${i}`, answer: 'x', user: 'Nico' });
    }
    await service.save({ question: 'k0', answer: 'x', user: 'kei' });

    expect(await model.countDocuments({ user: 'Nico' })).toBe(4);
    expect(await model.countDocuments({ user: 'kei' })).toBe(1);
  });

  it('save ignora un par sin usuario', async () => {
    await service.save({ question: 'hola', answer: 'qué tal', user: '' });
    expect(await model.countDocuments({})).toBe(0);
  });
});
