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

    // ─── Revisión final de rama (Important #3) ────────────────────────────
    //
    // El único test de este archivo aseveraba SÓLO `SAVE_FACT_ABOUT`, con un
    // describe titulado "tramo de terceros" que se lee como si cubriera el
    // bloque entero. Se comprobó: borrando el párrafo completo de
    // `SAVE_ERRAND` del prompt, la suite daba 554 passed. Ese párrafo es lo
    // único que hace que el modelo emita `SAVE_ERRAND`, así que las Tasks 4 y
    // 5 enteras (la colección `bot_errands`, la cola FIFO, el camino de
    // entrega) podían quedar inertes en producción con la suite en verde.
    it('el tramo de terceros también enseña SAVE_ERRAND, no sólo SAVE_FACT_ABOUT', () => {
      const base = {
        botName: 'aria',
        username: 'leon',
        maxLength: 200,
        personality: 'default' as const,
        useMemory: true,
        now: new Date('2026-08-02T12:00:00Z'),
        blocks: ['SAVE_FACT'] as PromptBlock[],
      };

      expect(service.build({ ...base, crossContext: false })).not.toContain('SAVE_ERRAND');
      expect(service.build({ ...base, crossContext: true })).toContain('SAVE_ERRAND');
    });

    // ─── Revisión final de rama (deuda #2) ────────────────────────────────
    //
    // El bloque no le decía al modelo dos reglas que el código SÍ aplica y
    // descarta en silencio: el sujeto/destinatario tiene que ser alguien ya
    // conocido, y no puede ser el bot. Sin señal en el prompt, el modelo
    // seguía emitiendo verbos que se tiran.
    it('el tramo de terceros exige que el sujeto sea alguien de la sala y excluye al propio bot', () => {
      const salida = service.build({
        botName: 'aria',
        username: 'leon',
        maxLength: 200,
        personality: 'default',
        useMemory: true,
        now: new Date('2026-08-02T12:00:00Z'),
        blocks: ['SAVE_FACT'] as PromptBlock[],
        crossContext: true,
      });

      expect(salida).toContain('ya escribió en esta sala');
      expect(salida).toContain('Nunca sobre vos mismo (aria)');
      expect(salida).toContain('nunca podés ser vos mismo (aria)');
    });

    it('sin botName, el tramo no dice "vos mismo (undefined)"', () => {
      const salida = service.build({
        username: 'leon',
        maxLength: 200,
        personality: 'default',
        useMemory: true,
        now: new Date('2026-08-02T12:00:00Z'),
        blocks: ['SAVE_FACT'] as PromptBlock[],
        crossContext: true,
      });

      expect(salida).not.toContain('undefined');
    });
  });
});
