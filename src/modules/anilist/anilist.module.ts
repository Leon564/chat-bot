import { Module } from '@nestjs/common';
import { AniListService } from './anilist.service';

@Module({
  providers: [AniListService],
  exports: [AniListService],
})
export class AniListModule {}
