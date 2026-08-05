import { Module } from '@nestjs/common';
import { CrossContextSettingsService } from './cross-context-settings.service';

/**
 * Módulo hoja, sin imports propios más allá de la config global — igual que
 * `UtilsModule`. Lo importan GraphModule, ChatModule y BotModule, y los tres
 * reciben la misma instancia singleton, que es lo que hace que el override en
 * runtime los mueva a todos a la vez.
 */
@Module({
  providers: [CrossContextSettingsService],
  exports: [CrossContextSettingsService],
})
export class CrossContextModule {}
