import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatService } from './chat.service';
import { ContextService } from './context.service';
import { MessagesService } from './messages.service';
import { OnlineUsersService } from './online-users.service';
import { UsageService } from './usage.service';
import { UtilsModule } from '../../common/utils/utils.module';
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
import { GraphModule } from '../graph/graph.module';
import { CrossContextModule } from '../../common/settings/cross-context.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Memory.name, schema: MemorySchema },
      { name: MessageLog.name, schema: MessageLogSchema },
      { name: EventLog.name, schema: EventLogSchema },
      { name: Context.name, schema: ContextSchema },
      { name: LlmUsage.name, schema: LlmUsageSchema },
    ]),
    GraphModule,
    UtilsModule,
    CrossContextModule,
  ],
  providers: [ChatService, ContextService, MessagesService, OnlineUsersService, UsageService, MemoryService, LoggingService, MigrationService, PromptBuilderService, IntentRouterService],
  // UtilsService ya no se declara acá: viene de UtilsModule (importado
  // arriba). Nest NO permite reexportar un provider individual que llegó vía
  // un módulo importado — solo se puede exportar un token propio (declarado
  // en `providers` de este mismo módulo) o el módulo entero. Reexportar
  // `UtilsService` directamente acá revienta el boot con
  // `UnknownExportException` ("Nest cannot export a provider/module that is
  // not a part of the currently processed module"). Por eso se exporta
  // `UtilsModule` completo: BotModule sigue recibiendo `UtilsService` a
  // través de `ChatModule` sin cambios en su propio código.
  exports: [ChatService, MessagesService, OnlineUsersService, MemoryService, LoggingService, UtilsModule, UsageService, MongooseModule],
})
export class ChatModule {}