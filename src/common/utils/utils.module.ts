import { Module } from '@nestjs/common';
import { UtilsService } from './utils.service';

/**
 * Módulo compartido para `UtilsService` (sanitización/format helpers sin
 * estado ni dependencias propias). Antes se declaraba como provider local en
 * `ChatModule` y en `GraphModule` por separado — dos instancias del mismo
 * servicio sin estado. Ahora ambos módulos importan `UtilsModule` y reciben
 * la misma instancia singleton.
 */
@Module({
  providers: [UtilsService],
  exports: [UtilsService],
})
export class UtilsModule {}
