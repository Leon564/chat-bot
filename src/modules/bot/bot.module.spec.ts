import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { rootMongooseTestModule, closeMongoConnection } from '../../common/testing/mongo-test.helper';
import { BotModule } from './bot.module';
import { BotService } from './bot.service';
import { MusicService } from '../music/music.service';

/**
 * Ronda de corrección 1 (hallazgo Critical #1 y #3): ni `npx jest` ni
 * `npm run build` detectan un `UnknownExportException` — webpack solo
 * transpila, no valida el grafo de inyección de Nest, y hasta esta suite no
 * existía ningún test que compilara `ChatModule`/`BotModule` reales. Esto
 * fue justamente lo que dejó pasar el bug de la Task 1: reexportar
 * `UtilsService` (un token que llega vía un módulo importado, no propio) en
 * `ChatModule.exports` crashea el boot ANTES de conectar a Mongo, pero
 * compilaba con webpack y no rompía ningún test.
 *
 * `Test.createTestingModule({ imports: [BotModule] }).compile()` fuerza a
 * Nest a resolver el grafo de inyección completo (dependencias +
 * imports/exports de cada módulo) tal como lo hace `NestFactory.create()` en
 * el arranque real — es la parte que revienta con `UnknownExportException`.
 * A propósito NO se llama a `app.init()` / `moduleRef.init()`: eso
 * dispararía `onModuleInit` en `BotService`/`ChatSocketService` (conectar al
 * socket del chat) y en `GraphMigrationService` (migración de datos), que no
 * queremos ejecutar en un test. `compile()` resuelve el grafo de DI sin
 * llamar a ningún lifecycle hook, así que alcanza para atrapar este error.
 */
describe('BotModule (wiring real)', () => {
  let connection: Connection;

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  it('compila el grafo de inyección completo sin errores de Nest', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        // ChatService construye un cliente OpenAI en su constructor y ese
        // constructor exige `apiKey` (revienta con "Missing credentials" si
        // es `undefined`) — le damos un valor dummy vía `load`, igual que
        // GraphModule necesita un ConfigModule real y global porque no lo
        // importa por su cuenta (ver el comentario de graph.module.spec.ts).
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ openai: { apiKey: 'test-key', baseURL: 'https://api.openai.com/v1' } })],
        }),
        BotModule,
      ],
    })
      // `MusicService` (dentro de `MusicModule`, importado por `BotModule`)
      // dispara en su propio constructor una verificación async de yt-dlp
      // sin esperarla (exec de un binario externo / posible descarga) que
      // sigue corriendo después de que el test termina y el proceso de Jest
      // sale con código 1 ("Cannot log after tests are done"), aunque el
      // assert haya pasado. No tiene relación con el bug de esta tarea
      // (reexportar `UtilsService`) — es un efecto secundario no relacionado
      // de un módulo hermano. Lo reemplazamos por un stub para poder validar
      // el grafo de inyección real de `BotModule` (incluida la cadena
      // `BotService` → `ChatModule` → `UtilsModule` que tenía el bug) sin la
      // contaminación de un proceso externo.
      .overrideProvider(MusicService)
      .useValue({})
      .compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    const service = moduleRef.get<BotService>(BotService);

    expect(service).toBeInstanceOf(BotService);
  });
});
