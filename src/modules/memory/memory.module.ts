import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BotMemory, BotMemorySchema } from '../../common/schemas/bot-memory.schema';
import { BotFollowup, BotFollowupSchema } from '../../common/schemas/bot-followup.schema';
import { MemoryStore } from './memory-store.service';
import { MemorySettingsService } from './memory-settings.service';

/** Memoria a largo plazo de Aria (ver docs/superpowers/specs/2026-11-22-memoria-largo-plazo-design.md). */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BotMemory.name, schema: BotMemorySchema },
      { name: BotFollowup.name, schema: BotFollowupSchema },
    ]),
  ],
  providers: [MemoryStore, MemorySettingsService],
  exports: [MemoryStore, MemorySettingsService],
})
export class MemoryModule {}
