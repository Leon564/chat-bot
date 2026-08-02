import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GraphNode, GraphNodeSchema } from '../../common/schemas/graph-node.schema';
import { GraphEdge, GraphEdgeSchema } from '../../common/schemas/graph-edge.schema';
import { GraphMigration, GraphMigrationSchema } from '../../common/schemas/graph-migration.schema';
import { Memory, MemorySchema } from '../../common/schemas/memory.schema';
import { GraphService } from './graph.service';
import { GraphIngestService } from './graph-ingest.service';
import { GraphMigrationService } from './graph-migration.service';
import { GraphCacheService } from './graph-cache.service';

/**
 * Módulo autónomo del grafo. No importa ningún otro módulo del bot a
 * propósito: tanto ChatModule como BotModule van a depender de él, así que
 * cualquier dependencia hacia arriba crearía un ciclo.
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
  providers: [GraphService, GraphIngestService, GraphMigrationService, GraphCacheService],
  exports: [GraphService, GraphIngestService, GraphCacheService, MongooseModule],
})
export class GraphModule {}
