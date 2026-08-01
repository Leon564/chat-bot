import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatService } from './chat.service';
import { ContextService } from './context.service';
import { MessagesService } from './messages.service';
import { OnlineUsersService } from './online-users.service';
import { UsageService } from './usage.service';
import { UtilsService } from '../../common/utils/utils.service';
import { MemoryService } from '../../common/utils/memory.service';
import { LoggingService } from '../../common/utils/logging.service';
import { Memory, MemorySchema } from '../../common/schemas/memory.schema';
import { MessageLog, MessageLogSchema } from '../../common/schemas/message-log.schema';
import { EventLog, EventLogSchema } from '../../common/schemas/event-log.schema';
import { Context, ContextSchema } from '../../common/schemas/context.schema';
import { LlmUsage, LlmUsageSchema } from '../../common/schemas/llm-usage.schema';
import { MigrationService } from '../../common/utils/migration.service';
import { PromptBuilderService } from './prompt-builder.service';
import { IntentRouterService } from './intent-router.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Memory.name, schema: MemorySchema },
      { name: MessageLog.name, schema: MessageLogSchema },
      { name: EventLog.name, schema: EventLogSchema },
      { name: Context.name, schema: ContextSchema },
      { name: LlmUsage.name, schema: LlmUsageSchema },
    ]),
  ],
  providers: [ChatService, ContextService, MessagesService, OnlineUsersService, UsageService, UtilsService, MemoryService, LoggingService, MigrationService, PromptBuilderService, IntentRouterService],
  exports: [ChatService, MessagesService, OnlineUsersService, MemoryService, LoggingService, UtilsService, MongooseModule],
})
export class ChatModule {}