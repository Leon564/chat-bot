import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
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
      imports: [
        rootMongooseTestModule(),
        // GraphCacheService depende de ConfigService (CACHE_ENABLED) — en la
        // app real lo provee el ConfigModule global de AppModule; acá, como
        // GraphModule se testea aislado, hay que darle uno real y global
        // (una simple mock provider no sería visible dentro de GraphModule,
        // que no importa ConfigModule por su cuenta).
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        GraphModule,
      ],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    const service = moduleRef.get<GraphService>(GraphService);

    expect(service).toBeInstanceOf(GraphService);
    expect(typeof service.normalizeKey).toBe('function');
  });
});
