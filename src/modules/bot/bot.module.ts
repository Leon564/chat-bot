import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { MusicModule } from '../music/music.module';
import { MessagesService } from '../chat/messages.service';
import { UtilsService } from '../../common/utils/utils.service';
import { LoggingService } from '../../common/utils/logging.service';
import { MemoryService } from '../../common/utils/memory.service';

@Module({
  imports: [AuthModule, ChatModule, MusicModule],
  providers: [
    BotService,
    MessagesService,
    UtilsService,
    LoggingService,
    MemoryService,
  ],
  exports: [BotService],
})
export class BotModule {}