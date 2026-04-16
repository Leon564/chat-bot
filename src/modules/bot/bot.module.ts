import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { ChatModule } from '../chat/chat.module';
import { MusicModule } from '../music/music.module';
import { ChatSocketModule } from '../chat-socket/chat-socket.module';
import { UtilsService } from '../../common/utils/utils.service';
import { LoggingService } from '../../common/utils/logging.service';
import { MemoryService } from '../../common/utils/memory.service';

@Module({
  imports: [ChatModule, MusicModule, ChatSocketModule],
  providers: [
    BotService,
    UtilsService,
    LoggingService,
    MemoryService,
  ],
  exports: [BotService],
})
export class BotModule {}