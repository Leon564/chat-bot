import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { rootMongooseTestModule, closeMongoConnection } from '../testing/mongo-test.helper';
import { MessageLog, MessageLogSchema } from '../schemas/message-log.schema';
import { EventLog, EventLogSchema } from '../schemas/event-log.schema';
import { LoggingService } from './logging.service';
import { UtilsService } from './utils.service';

describe('LoggingService — log de mensajes', () => {
  let service: LoggingService;
  let connection: Connection;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([
          { name: MessageLog.name, schema: MessageLogSchema },
          { name: EventLog.name, schema: EventLogSchema },
        ]),
      ],
      providers: [LoggingService, UtilsService, { provide: ConfigService, useValue: { get: () => undefined } }],
    }).compile();
    service = moduleRef.get(LoggingService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await connection.collection('messages_log').deleteMany({});
  });

  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('getLastMessages devuelve del más viejo al más nuevo y, con `since`, sólo lo posterior', async () => {
    await service.saveLog('kei', 'uno');
    await tick();
    const corte = new Date();
    await tick();
    await service.saveLog('lyna', 'dos');
    await service.saveLog('kei', 'tres');

    expect((await service.getLastMessages()).map((m) => m.message)).toEqual(['uno', 'dos', 'tres']);
    expect((await service.getLastMessages(corte)).map((m) => m.message)).toEqual(['dos', 'tres']);
  });

  it('getRecent respeta el límite y se queda con los más nuevos', async () => {
    for (const m of ['a', 'b', 'c', 'd']) {
      await service.saveLog('kei', m);
      await tick();
    }
    expect((await service.getRecent(2, 15)).map((m) => m.message)).toEqual(['c', 'd']);
    expect(await service.getRecent(0, 15)).toEqual([]);
  });
});
