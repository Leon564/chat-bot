import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GraphNode, GraphNodeSchema } from '../../common/schemas/graph-node.schema';
import { GraphEdge, GraphEdgeSchema } from '../../common/schemas/graph-edge.schema';
import { GraphMigration, GraphMigrationSchema } from '../../common/schemas/graph-migration.schema';
import { Memory, MemorySchema } from '../../common/schemas/memory.schema';
import { UtilsModule } from '../../common/utils/utils.module';
import { CrossContextModule } from '../../common/settings/cross-context.module';
import { GraphService } from './graph.service';
import { GraphIngestService } from './graph-ingest.service';
import { GraphMigrationService } from './graph-migration.service';
import { GraphUserKeyMigrationService } from './graph-user-key-migration.service';
import { GraphCacheService } from './graph-cache.service';
import { GraphContextService } from './graph-context.service';
import { GraphUserService } from './graph-user.service';

/**
 * Módulo autónomo del grafo. No importa `ChatModule` a propósito: tanto
 * ChatModule como BotModule van a depender de él, así que cualquier
 * dependencia hacia arriba crearía un ciclo. `UtilsService` (sin
 * dependencias propias, usado por `GraphIngestService.ingestFact` desde la
 * Task 4 de la fase 4b) ya no se declara acá como provider local: desde la
 * Task 1 de la fase 5a vive en `UtilsModule`, un módulo hoja sin imports
 * propios, así que importarlo acá no crea ningún ciclo — ChatModule también
 * lo importa, y ambos reciben la misma instancia singleton.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GraphNode.name, schema: GraphNodeSchema },
      { name: GraphEdge.name, schema: GraphEdgeSchema },
      { name: GraphMigration.name, schema: GraphMigrationSchema },
      { name: Memory.name, schema: MemorySchema },
    ]),
    UtilsModule,
    CrossContextModule,
  ],
  providers: [
    GraphService,
    GraphIngestService,
    GraphMigrationService,
    GraphUserKeyMigrationService,
    GraphCacheService,
    GraphContextService,
    GraphUserService,
  ],
  exports: [
    GraphService,
    GraphIngestService,
    GraphCacheService,
    GraphContextService,
    GraphUserService,
    MongooseModule,
  ],
})
export class GraphModule {}
