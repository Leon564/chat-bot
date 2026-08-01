import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GraphNode, GraphNodeSchema } from '../../common/schemas/graph-node.schema';
import { GraphEdge, GraphEdgeSchema } from '../../common/schemas/graph-edge.schema';
import { GraphService } from './graph.service';

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
    ]),
  ],
  providers: [GraphService],
  exports: [GraphService, MongooseModule],
})
export class GraphModule {}
