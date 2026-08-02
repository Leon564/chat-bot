import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GraphNode, GraphNodeSchema } from '../../common/schemas/graph-node.schema';
import { GraphEdge, GraphEdgeSchema } from '../../common/schemas/graph-edge.schema';
import { GraphMigration, GraphMigrationSchema } from '../../common/schemas/graph-migration.schema';
import { Memory, MemorySchema } from '../../common/schemas/memory.schema';
import { UtilsService } from '../../common/utils/utils.service';
import { GraphService } from './graph.service';
import { GraphIngestService } from './graph-ingest.service';
import { GraphMigrationService } from './graph-migration.service';
import { GraphCacheService } from './graph-cache.service';
import { GraphContextService } from './graph-context.service';

/**
 * Módulo autónomo del grafo. No importa ningún otro módulo del bot a
 * propósito: tanto ChatModule como BotModule van a depender de él, así que
 * cualquier dependencia hacia arriba crearía un ciclo. Por eso `UtilsService`
 * (sin dependencias propias, usado por `GraphIngestService.ingestFact` desde
 * la Task 4 de la fase 4b) se declara acá como provider propio en vez de
 * importarlo desde `ChatModule` — el mismo patrón que ya usa `ChatModule` en
 * vez de un `UtilsModule` compartido.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GraphNode.name, schema: GraphNodeSchema },
      { name: GraphEdge.name, schema: GraphEdgeSchema },
      { name: GraphMigration.name, schema: GraphMigrationSchema },
      { name: Memory.name, schema: MemorySchema },
    ]),
  ],
  providers: [GraphService, GraphIngestService, GraphMigrationService, GraphCacheService, GraphContextService, UtilsService],
  exports: [GraphService, GraphIngestService, GraphCacheService, GraphContextService, MongooseModule],
})
export class GraphModule {}
