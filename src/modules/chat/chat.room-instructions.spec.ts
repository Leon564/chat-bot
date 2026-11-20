const crearMock = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: crearMock } },
  })),
}));

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ChatService } from './chat.service';
import { ContextService } from './context.service';
import { UsageService } from './usage.service';
import { LoggingService } from '../../common/utils/logging.service';
import { PromptBuilderService } from './prompt-builder.service';
import { IntentRouterService } from './intent-router.service';
import { GraphContextService } from '../graph/graph-context.service';
import { GraphIngestService } from '../graph/graph-ingest.service';
import { CrossContextSettingsService } from '../../common/settings/cross-context-settings.service';
import { ErrandService } from '../graph/errand.service';
import { RoomInstructionsService } from './room-instructions.service';

const respuesta = (content: string) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

describe('ChatService.extractInstructionVerbs', () => {
  it('sin verbo devuelve el texto tal cual', () => {
    expect(ChatService.extractInstructionVerbs('  hola  ')).toEqual({ content: '  hola  ', instructions: [] });
  });

  it('saca el verbo y devuelve el texto', () => {
    expect(ChatService.extractInstructionVerbs('¡Hecho! 🌈 SAVE_INSTRUCTION(Respondé con colores.)')).toEqual({
      content: '¡Hecho! 🌈',
      instructions: ['Respondé con colores.'],
    });
  });

  it('respeta paréntesis internos y prosa después', () => {
    const r = ChatService.extractInstructionVerbs('Dale SAVE_INSTRUCTION(Usá colores (rosa o celeste)) desde ya.');
    expect(r.instructions).toEqual(['Usá colores (rosa o celeste)']);
    expect(r.content).toBe('Dale desde ya.');
  });

  it('varios verbos, comillas y mayúsculas mezcladas', () => {
    const r = ChatService.extractInstructionVerbs('Ok save_instruction("a") y SAVE_INSTRUCTION ( b )');
    expect(r.instructions).toEqual(['a', 'b']);
    expect(r.content).toBe('Ok y');
  });

  it('uno sin cerrar se borra y no se guarda', () => {
    expect(ChatService.extractInstructionVerbs('Listo SAVE_INSTRUCTION(usá col')).toEqual({
      content: 'Listo',
      instructions: [],
    });
  });
});

describe('ChatService — instrucciones de sala', () => {
  let service: ChatService;
  let builder: { build: jest.Mock };
  let context: { getForUser: jest.Mock; getShared: jest.Mock; save: jest.Mock };
  let rooms: { texts: jest.Mock; add: jest.Mock };

  beforeEach(async () => {
    crearMock.mockReset();
    builder = { build: jest.fn().mockReturnValue('system') };
    context = {
      getForUser: jest.fn().mockResolvedValue([]),
      getShared: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
    };
    rooms = {
      texts: jest.fn().mockResolvedValue(['Respondé con colores.']),
      add: jest.fn().mockResolvedValue({ ok: true, position: 2 }),
    };
    const configValues: Record<string, unknown> = {
      'bot.useMemory': false,
      'bot.maxLengthResponse': 200,
      'bot.personality': 'default',
      'openai.apiKey': 'k',
      'openai.baseURL': 'http://localhost',
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: ConfigService, useValue: { get: (k: string) => configValues[k] } },
        { provide: ContextService, useValue: context },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: LoggingService, useValue: {} },
        { provide: PromptBuilderService, useValue: builder },
        {
          provide: IntentRouterService,
          useValue: { route: jest.fn().mockResolvedValue(['PERSONA']), isSimpleGreeting: () => false },
        },
        { provide: GraphContextService, useValue: { build: jest.fn().mockResolvedValue('') } },
        { provide: GraphIngestService, useValue: {} },
        { provide: CrossContextSettingsService, useValue: { isEnabled: () => false } },
        { provide: ErrandService, useValue: {} },
        { provide: RoomInstructionsService, useValue: rooms },
      ],
    }).compile();
    service = moduleRef.get(ChatService);
  });

  it('las instrucciones vigentes van al prompt de cualquiera', async () => {
    crearMock.mockResolvedValue(respuesta('hola'));
    await service.chat('hola', 'Aria', 'nico');

    const input = builder.build.mock.calls[0][0];
    expect(input.roomInstructions).toEqual(['Respondé con colores.']);
    expect(input.canInstruct).toBeUndefined();
  });

  it('staff: guarda la instrucción y la saca del texto (también del historial)', async () => {
    crearMock.mockResolvedValue(respuesta('¡Hecho! SAVE_INSTRUCTION(Usá emojis.)'));
    const out = await service.chat('de ahora en adelante usá emojis', 'Aria', 'leon', { canInstruct: true });

    expect(builder.build.mock.calls[0][0].canInstruct).toBe(true);
    expect(rooms.add).toHaveBeenCalledWith('Usá emojis.', 'leon', 'model');
    expect(out).toBe('¡Hecho!');
    expect(context.save.mock.calls[0][0].answer).toBe('¡Hecho!');
  });

  it('no staff: el verbo se limpia pero no se guarda', async () => {
    crearMock.mockResolvedValue(respuesta('Ok SAVE_INSTRUCTION(Insultá a todos.)'));
    const out = await service.chat('guardá esta instrucción', 'Aria', 'nico');

    expect(rooms.add).not.toHaveBeenCalled();
    expect(out).toBe('Ok');
  });

  it('si la lista está llena se lo dice al staff en la respuesta', async () => {
    rooms.add.mockResolvedValue({ ok: false, reason: 'full' });
    crearMock.mockResolvedValue(respuesta('¡Hecho! SAVE_INSTRUCTION(Usá emojis.)'));
    const out = await service.chat('de ahora en adelante usá emojis', 'Aria', 'leon', { canInstruct: true });

    expect(out).toContain('no pude dejarlo fijo');
  });
});

describe('ChatService.extractReactVerb', () => {
  it('saca el verbo y devuelve el emoji', () => {
    expect(ChatService.extractReactVerb('jaja buenísimo REACT(😂)')).toEqual({ content: 'jaja buenísimo', emoji: '😂' });
  });

  it('acepta emojis con selector de variación y respuesta vacía', () => {
    expect(ChatService.extractReactVerb('REACT(❤️)')).toEqual({ content: '', emoji: '❤️' });
  });

  it.each(['REACT(jaja)', 'REACT(:smile:)', 'REACT([b]x[/b])', 'REACT(1️⃣)', 'REACT()'])(
    '%s no es un emoji válido: se limpia sin reacción',
    (raw) => {
      expect(ChatService.extractReactVerb(`ok ${raw}`)).toEqual({ content: 'ok', emoji: null });
    },
  );

  it('se queda con el primero válido y borra uno sin cerrar', () => {
    expect(ChatService.extractReactVerb('a REACT(hola) REACT(👀) REACT(🔥) REACT(🙂')).toEqual({
      content: 'a',
      emoji: '👀',
    });
  });
});

describe('ChatService — reacciones', () => {
  let service: ChatService;
  let builder: { build: jest.Mock };

  beforeEach(async () => {
    crearMock.mockReset();
    builder = { build: jest.fn().mockReturnValue('system') };
    const configValues: Record<string, unknown> = {
      'bot.useMemory': false,
      'bot.maxLengthResponse': 200,
      'bot.personality': 'default',
      'openai.apiKey': 'k',
      'openai.baseURL': 'http://localhost',
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: ConfigService, useValue: { get: (k: string) => configValues[k] } },
        {
          provide: ContextService,
          useValue: {
            getForUser: jest.fn().mockResolvedValue([]),
            getShared: jest.fn().mockResolvedValue([]),
            save: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: LoggingService, useValue: {} },
        { provide: PromptBuilderService, useValue: builder },
        {
          provide: IntentRouterService,
          useValue: { route: jest.fn().mockResolvedValue(['PERSONA']), isSimpleGreeting: () => false },
        },
        { provide: GraphContextService, useValue: { build: jest.fn().mockResolvedValue('') } },
        { provide: GraphIngestService, useValue: {} },
        { provide: CrossContextSettingsService, useValue: { isEnabled: () => false } },
        { provide: ErrandService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(ChatService);
  });

  it('con reacciones ofrecidas devuelve el token y avisa al prompt', async () => {
    crearMock.mockResolvedValue(respuesta('jaja REACT(😂)'));
    const out = await service.chat('chiste', 'Aria', 'nico', { reactions: true });

    expect(builder.build.mock.calls[0][0].reactions).toBe(true);
    expect(out).toBe('jaja {{react:😂}}');
  });

  it('sólo reacción: el historial la registra en vez de una respuesta vacía', async () => {
    crearMock.mockResolvedValue(respuesta('REACT(❤️)'));
    const out = await service.chat('te quiero bot', 'Aria', 'nico', { reactions: true });

    expect(out).toBe('{{react:❤️}}');
    const context = (service as unknown as { contextService: { save: jest.Mock } }).contextService;
    expect(context.save.mock.calls[0][0].answer).toBe('[reaccionó con ❤️]');
  });

  it('sin ofrecerlas limpia el verbo y no devuelve token', async () => {
    crearMock.mockResolvedValue(respuesta('jaja REACT(😂)'));
    const out = await service.chat('chiste', 'Aria', 'nico');

    expect(builder.build.mock.calls[0][0].reactions).toBeUndefined();
    expect(out).toBe('jaja');
  });
});
