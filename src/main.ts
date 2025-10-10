import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  const logger = new Logger('Bootstrap');
  
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