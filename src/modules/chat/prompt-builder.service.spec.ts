import { Test } from '@nestjs/testing';
import { PromptBuilderService, ALL_BLOCKS, PromptInput, PromptBlock } from './prompt-builder.service';

const baseInput = (over: Partial<PromptInput> = {}): PromptInput => ({
  botName: 'Aria',
  username: 'Nico',
  maxLength: 200,
  personality: 'default',
  useMemory: true,
  // Fecha fija: el bloque temporal depende de ella y el test tiene que ser
  // determinista. Un martes por la tarde, sin evento especial.
  now: new Date('2026-03-17T15:30:00-06:00'),
  blocks: [...ALL_BLOCKS],
  ...over,
});

describe('PromptBuilderService', () => {
  let service: PromptBuilderService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PromptBuilderService],
    }).compile();
    service = moduleRef.get<PromptBuilderService>(PromptBuilderService);
  });

  describe('inclusión y exclusión de bloques', () => {
    const marcadores: Record<string, string> = {
      MUSIC: 'COMANDOS DE MÚSICA',
      ANILIST: 'BÚSQUEDA EN ANILIST',
      IDENTIDAD: 'INFORMACIÓN PERSONAL',
      RESUMEN: 'RESÚMENES DEL CHAT',
      ONLINE: 'USUARIOS EN LÍNEA',
    };

    it.each(Object.entries(marcadores))(
      'incluye el bloque %s cuando se lo pide',
      (bloque, marcador) => {
        const salida = service.build(baseInput({ blocks: ['PERSONA', bloque as never] }));
        expect(salida).toContain(marcador);
      },
    );

    it.each(Object.entries(marcadores))(
      'omite el bloque %s cuando no se lo pide',
      (bloque, marcador) => {
        const otros = ALL_BLOCKS.filter((b) => b !== bloque);
        const salida = service.build(baseInput({ blocks: otros }));
        expect(salida).not.toContain(marcador);
      },
    );

    it('siempre incluye la persona', () => {
      const salida = service.build(baseInput({ blocks: ['PERSONA'] }));
      expect(salida).toContain('Aria');
      expect(salida).toContain('Nico');
    });
  });

  describe('línea CRÍTICO dinámica', () => {
    it('nombra sólo los tokens de los bloques incluidos', () => {
      const salida = service.build(baseInput({ blocks: ['PERSONA', 'ANILIST'] }));
      expect(salida).toContain('{{anilist:');
      expect(salida).not.toContain('{{music:');
      expect(salida).not.toContain('{{resumen}}');
      expect(salida).not.toContain('{{usuarios_online}}');
    });

    it('no aparece cuando ningún bloque de token está incluido', () => {
      const salida = service.build(baseInput({ blocks: ['PERSONA', 'TEMPORAL'] }));
      expect(salida).not.toContain('CRÍTICO');
    });
  });

  describe('ahorro', () => {
    it('un saludo pesa mucho menos que el prompt completo', () => {
      const completo = service.build(baseInput());
      const saludo = service.build(baseInput({ blocks: ['PERSONA', 'TEMPORAL'] }));

      // No se mide en tokens porque no hay tokenizador acá, pero los
      // caracteres son proporcionales y la diferencia es del orden esperado.
      expect(saludo.length).toBeLessThan(completo.length * 0.35);
    });
  });

  describe('bloque temporal', () => {
    it('usa la fecha que se le pasa, no la del reloj', () => {
      const salida = service.build(
        baseInput({ blocks: ['PERSONA', 'TEMPORAL'], now: new Date('2026-12-25T10:00:00-06:00') }),
      );
      expect(salida).toContain('Navidad');
    });
  });

  describe('bloque SAVE_FACT (Task 4, fase 4b — reemplaza a SAVE_MEMORY)', () => {
    it('el bloque SAVE_MEMORY ya no menciona SAVE_MEMORY', () => {
      const salida = service.build(baseInput({ blocks: ['PERSONA', 'SAVE_FACT'], useMemory: true }));
      expect(salida).not.toContain('SAVE_MEMORY');
    });

    it('menciona SAVE_FACT y las tres relaciones válidas', () => {
      const salida = service.build(baseInput({ blocks: ['PERSONA', 'SAVE_FACT'], useMemory: true }));
      expect(salida).toContain('SAVE_FACT');
      expect(salida).toContain('likes');
      expect(salida).toContain('dislikes');
      expect(salida).toContain('asked_about');
    });

    it('sigue sin aparecer cuando el bloque no está en `blocks`', () => {
      const otros = ALL_BLOCKS.filter((b) => b !== 'SAVE_FACT');
      const salida = service.build(baseInput({ blocks: otros, useMemory: true }));
      expect(salida).not.toContain('SAVE_FACT');
      expect(salida).not.toContain('SISTEMA DE MEMORIA');
    });
  });

  describe('tramo de terceros (Task 3, contexto cruzado — SAVE_FACT_ABOUT)', () => {
    it('el tramo de terceros sólo aparece con crossContext', () => {
      const base = {
        botName: 'aria',
        username: 'leon',
        maxLength: 200,
        personality: 'default' as const,
        useMemory: true,
        now: new Date('2026-08-02T12:00:00Z'),
        blocks: ['SAVE_FACT'] as PromptBlock[],
      };

      expect(service.build({ ...base, crossContext: false })).not.toContain('SAVE_FACT_ABOUT');
      expect(service.build({ ...base, crossContext: true })).toContain('SAVE_FACT_ABOUT');
    });
  });
});
