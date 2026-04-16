import { Module } from '@nestjs/common';
import { ChatSocketService } from './chat-socket.service';

@Module({
  providers: [ChatSocketService],
  exports: [ChatSocketService],
})
export class ChatSocketModule {}
