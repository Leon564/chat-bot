import { Module } from '@nestjs/common';
import { MusicService } from './music.service';
import { GraphModule } from '../graph/graph.module';

/**
 * Importa GraphModule para poder inyectar GraphCacheService/GraphService y
 * servir canciones ya subidas desde el grafo antes de re-procesarlas.
 * GraphModule no importa ningún módulo del bot, así que esto no crea un
 * ciclo (ver el comentario en graph.module.ts).
 */
@Module({
  imports: [GraphModule],
  providers: [MusicService],
  exports: [MusicService],
})
export class MusicModule {}