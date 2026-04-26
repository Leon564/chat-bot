import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { ChatModule } from '../chat/chat.module';
import { MusicModule } from '../music/music.module';
import { ChatSocketModule } from '../chat-socket/chat-socket.module';

@Module({
  // ChatModule re-exports UtilsService, MemoryService, LoggingService and the
  // Mongoose models, so we no longer need duplicate providers here.
  imports: [ChatModule, MusicModule, ChatSocketModule],
  providers: [BotService],
  exports: [BotService],
})
export class BotModule {}