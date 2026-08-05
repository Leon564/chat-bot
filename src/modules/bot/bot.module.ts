import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { RateLimitService } from './rate-limit.service';
import { ChatModule } from '../chat/chat.module';
import { MusicModule } from '../music/music.module';
import { ChatSocketModule } from '../chat-socket/chat-socket.module';
import { AniListModule } from '../anilist/anilist.module';
import { GraphModule } from '../graph/graph.module';
import { CrossContextModule } from '../../common/settings/cross-context.module';

@Module({
  // ChatModule re-exports UtilsService, MemoryService, LoggingService and the
  // Mongoose models, so we no longer need duplicate providers here.
  imports: [ChatModule, MusicModule, ChatSocketModule, AniListModule, GraphModule, CrossContextModule],
  providers: [BotService, RateLimitService],
  exports: [BotService],
})
export class BotModule {}