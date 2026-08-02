import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { rootMongooseTestModule, closeMongoConnection } from '../testing/mongo-test.helper';
import { UtilsModule } from './utils.module';
import { UtilsService } from './utils.service';
import { ChatModule } from '../../modules/chat/chat.module';
import { GraphModule } from '../../modules/graph/graph.module';
import { MessagesService } from '../../modules/chat/messages.service';
import { GraphIngestService } from '../../modules/graph/graph-ingest.service';

describe('UtilsModule', () => {
  it('provee UtilsService a quien lo importe', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [UtilsModule] }).compile();
    expect(moduleRef.get<UtilsService>(UtilsService)).toBeInstanceOf(UtilsService);
  });

  describe('devuelve la MISMA instancia a los módulos reales que lo importan', () => {
    let connection: Connection;

    afterAll(async () => {
      await closeMongoConnection(connection);
    });

    it('ChatModule y GraphModule comparten la instancia de UtilsService', async () => {
      // Es el punto de la tarea: antes de este refactor, ChatModule y
      // GraphModule declaraban `UtilsService` cada uno como provider propio
      // (dos instancias). Un primer intento de este test usaba dos módulos
      // SINTÉTICOS (`ModuloA`/`ModuloB`) que importaban `UtilsModule` —
      // eso solo prueba una propiedad genérica de Nest (dos imports del
      // mismo módulo comparten singleton), no que los módulos REALES del
      // repo hayan dejado de declarar su propio provider: restaurando
      // `UtilsService` como provider local en ambos módulos, ese test
      // seguía en verde. Por eso acá se compilan `ChatModule` y
      // `GraphModule` reales y se compara la instancia de `UtilsService`
      // que cada uno efectivamente inyectó en uno de sus propios
      // providers — `MessagesService.utilsService` (ChatModule) y
      // `GraphIngestService.utilsService` (GraphModule) — en vez de pedir
      // el token directamente, que no distinguiría de qué módulo vino.
      //
      // Verificado manualmente revirtiendo `ChatModule`/`GraphModule` a
      // declarar `UtilsService` localmente (sin `UtilsModule`): este test
      // falla (`consumidorA !== consumidorB`), tal como debe. Ver
      // task-1-report.md para el detalle de esa verificación.
      const moduleRef = await Test.createTestingModule({
        imports: [
          rootMongooseTestModule(),
          // GraphModule (importado por ChatModule y también directamente
          // acá) necesita un ConfigModule real y global porque no lo
          // importa por su cuenta — mismo motivo que en graph.module.spec.ts.
          // ChatModule además construye un cliente OpenAI en el constructor
          // de ChatService, que exige `apiKey` — le damos un valor dummy.
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [() => ({ openai: { apiKey: 'test-key', baseURL: 'https://api.openai.com/v1' } })],
          }),
          ChatModule,
          GraphModule,
        ],
      }).compile();

      connection = moduleRef.get<Connection>(getConnectionToken());

      const messagesService = moduleRef.get<MessagesService>(MessagesService);
      const graphIngestService = moduleRef.get<GraphIngestService>(GraphIngestService);

      const utilsDesdeChat = (messagesService as unknown as { utilsService: UtilsService }).utilsService;
      const utilsDesdeGraph = (graphIngestService as unknown as { utilsService: UtilsService }).utilsService;

      expect(utilsDesdeChat).toBeInstanceOf(UtilsService);
      expect(utilsDesdeChat).toBe(utilsDesdeGraph);
    });
  });
});
