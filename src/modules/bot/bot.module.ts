import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { RateLimitService } from './rate-limit.service';
import { StickerGateService } from './sticker-gate.service';
import { MusicQuotaService } from './music-quota.service';
import { MusicIntentService } from './music-intent.service';
import { ChatModule } from '../chat/chat.module';
import { MusicModule } from '../music/music.module';
import { ChatSocketModule } from '../chat-socket/chat-socket.module';
import { AniListModule } from '../anilist/anilist.module';
import { GraphModule } from '../graph/graph.module';
import { CrossContextModule } from '../../common/settings/cross-context.module';

@Module({
  // ChatModule re-exports UtilsService, LoggingService and the
  // Mongoose models, so we no longer need duplicate providers here.
  imports: [ChatModule, MusicModule, ChatSocketModule, AniListModule, GraphModule, CrossContextModule],
  providers: [BotService, RateLimitService, StickerGateService, MusicQuotaService, MusicIntentService],
  exports: [BotService],
})
export class BotModule {}