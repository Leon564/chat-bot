import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BotMemory, BotMemorySchema } from '../../common/schemas/bot-memory.schema';
import { BotFollowup, BotFollowupSchema } from '../../common/schemas/bot-followup.schema';
import { MemoryStore } from './memory-store.service';
import { MemorySettingsService } from './memory-settings.service';
import { EmbeddingService } from './embedding.service';
import { MemoryRecallService } from './memory-recall.service';
import { FollowupService } from './followup.service';
import { LOCAL_EMBEDDER, TransformersLocalEmbedder } from './local-embedder';
import { LlmUsage, LlmUsageSchema } from '../../common/schemas/llm-usage.schema';
import { UsageService } from '../chat/usage.service';

/** Memoria a largo plazo de Aria (ver docs/superpowers/specs/2026-11-22-memoria-largo-plazo-design.md). */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BotMemory.name, schema: BotMemorySchema },
      { name: BotFollowup.name, schema: BotFollowupSchema },
      // Propio (no vía ChatModule, que importa éste): registra el uso de embeddings.
      { name: LlmUsage.name, schema: LlmUsageSchema },
    ]),
  ],
  providers: [
    MemoryStore,
    MemorySettingsService,
    EmbeddingService,
    MemoryRecallService,
    FollowupService,
    UsageService,
    { provide: LOCAL_EMBEDDER, useClass: TransformersLocalEmbedder },
  ],
  exports: [MemoryStore, MemorySettingsService, EmbeddingService, MemoryRecallService, FollowupService],
})
export class MemoryModule {}
