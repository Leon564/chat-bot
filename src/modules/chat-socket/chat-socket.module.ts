import { Module } from '@nestjs/common';
import { ChatSocketService } from './chat-socket.service';
import { StickerCatalogService } from './sticker-catalog.service';

@Module({
  providers: [ChatSocketService, StickerCatalogService],
  exports: [ChatSocketService, StickerCatalogService],
})
export class ChatSocketModule {}
