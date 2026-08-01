import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { rootMongooseTestModule, closeMongoConnection } from '../../common/testing/mongo-test.helper';
import { GraphModule } from './graph.module';
import { GraphService } from './graph.service';

describe('GraphModule', () => {
  let connection: Connection;

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  it('provee GraphService a quien lo importe', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [rootMongooseTestModule(), GraphModule],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    const service = moduleRef.get<GraphService>(GraphService);

    expect(service).toBeInstanceOf(GraphService);
    expect(typeof service.normalizeKey).toBe('function');
  });
});
