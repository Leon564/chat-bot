import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

/**
 * Diagnóstico de muertes silenciosas del proceso.
 *
 * `ChatSocketService.onMessage` tipa su handler como `void`, así que
 * `BotService.handleNewChatMessage(msg)` queda como una promesa flotante: nadie
 * la espera ni la captura. Cualquier rechazo adentro del manejo de un mensaje
 * termina como `unhandledRejection`, que en Node >= 15 mata el proceso por
 * defecto — y sin este handler, lo único que se ve es que el bot "se reinicia",
 * sin stack, sin archivo y sin línea.
 *
 * Se loguea y DESPUÉS se sale con el mismo código que usaría Node por su
 * cuenta: la intención es hacer visible el crash, no cambiar el comportamiento
 * ni tragarse errores. Un bot que sigue vivo con estado corrupto es peor que
 * uno que se reinicia.
 */
function installCrashLogging(logger: Logger) {
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(`💥 unhandledRejection: ${err.message}`, err.stack);
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.error(`💥 uncaughtException: ${err.message}`, err.stack);
    process.exit(1);
  });
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Antes de crear la app: un fallo durante el arranque también tiene que
  // dejar stack.
  installCrashLogging(logger);

  const app = await NestFactory.create(AppModule);

  // Enable graceful shutdown
  app.enableShutdownHooks();
  
  await app.init();
  
  logger.log('🤖 CBox Bot started successfully!');
  logger.log(`Memory system: ${process.env.USE_MEMORY === 'true' ? 'ENABLED' : 'DISABLED'}`);
  
  // Keep the application running
  process.on('SIGTERM', async () => {
    logger.log('Received SIGTERM, shutting down gracefully...');
    await app.close();
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});