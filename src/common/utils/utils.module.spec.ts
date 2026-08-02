import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UtilsModule } from './utils.module';
import { UtilsService } from './utils.service';

describe('UtilsModule', () => {
  it('provee UtilsService a quien lo importe', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [UtilsModule] }).compile();
    expect(moduleRef.get<UtilsService>(UtilsService)).toBeInstanceOf(UtilsService);
  });

  it('devuelve la MISMA instancia a dos módulos que lo importan', async () => {
    // Es el punto de la tarea: antes había una instancia por módulo (una en
    // ChatModule, otra en GraphModule). El approach original del brief
    // (`moduleRef.select(ModuloX).get(UtilsService, { strict: true })`)
    // falla en este Nest 10.4.22 con "Nest could not find UtilsService
    // element (this provider does not exist in the current context)":
    // `select()` navega el árbol de módulos, pero la búsqueda estricta en el
    // contexto de ModuloA/ModuloB no ve el token re-exportado desde
    // UtilsModule ahí (se resuelve distinto en el testing module que en una
    // app real). En vez de eso, probamos la unicidad de la forma en que el
    // caso real la necesita: dos módulos separados (análogos a ChatModule y
    // GraphModule), cada uno con su propio provider que recibe
    // `UtilsService` por constructor desde su propio `imports: [UtilsModule]`,
    // y comparamos la instancia que cada uno efectivamente recibió.
    class ConsumidorA {
      constructor(public readonly utils: UtilsService) {}
    }
    class ConsumidorB {
      constructor(public readonly utils: UtilsService) {}
    }

    @Module({
      imports: [UtilsModule],
      providers: [ConsumidorA],
      exports: [ConsumidorA],
    })
    class ModuloA {}

    @Module({
      imports: [UtilsModule],
      providers: [ConsumidorB],
      exports: [ConsumidorB],
    })
    class ModuloB {}

    const moduleRef = await Test.createTestingModule({ imports: [ModuloA, ModuloB] }).compile();

    const consumidorA = moduleRef.get<ConsumidorA>(ConsumidorA);
    const consumidorB = moduleRef.get<ConsumidorB>(ConsumidorB);

    expect(consumidorA.utils).toBe(consumidorB.utils);
  });
});
