import { Module } from '@nestjs/common';
import { ChatSocketService } from './chat-socket.service';
import { StickerCatalogService } from './sticker-catalog.service';
import { BbcodeSettingsService } from './bbcode-settings.service';

@Module({
  providers: [ChatSocketService, StickerCatalogService, BbcodeSettingsService],
  exports: [ChatSocketService, StickerCatalogService, BbcodeSettingsService],
})
export class ChatSocketModule {}
