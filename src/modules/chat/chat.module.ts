import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { UtilsService } from '../../common/utils/utils.service';
import { MemoryService } from '../../common/utils/memory.service';
import { LoggingService } from '../../common/utils/logging.service';

@Module({
  providers: [ChatService, UtilsService, MemoryService, LoggingService],
  exports: [ChatService],
})
export class ChatModule {}