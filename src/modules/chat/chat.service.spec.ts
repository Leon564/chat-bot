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
import { MemoryService } from '../../common/utils/memory.service';
import { LoggingService } from '../../common/utils/logging.service';
import { PromptBuilderService } from './prompt-builder.service';
import { IntentRouterService } from './intent-router.service';

const respuesta = (content: string, prompt = 100, completion = 20) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: prompt, completion_tokens: completion },
});

describe('ChatService — instrumentación de tokens', () => {
  let service: ChatService;
  let usage: { record: jest.Mock };
  let context: { getForUser: jest.Mock; save: jest.Mock };
  let builder: { build: jest.Mock };
  let router: { route: jest.Mock; isSimpleGreeting: jest.Mock };

  beforeEach(async () => {
    crearMock.mockReset();
    usage = { record: jest.fn().mockResolvedValue(undefined) };
    context = {
      getForUser: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
    };
    builder = { build: jest.fn().mockReturnValue('system prompt de prueba') };
    router = {
      route: jest.fn().mockResolvedValue(['PERSONA', 'TEMPORAL']),
      isSimpleGreeting: jest.fn().mockReturnValue(false),
    };

    const config = {
      get: jest.fn((clave: string) => {
        const valores: Record<string, unknown> = {
          'bot.useMemory': false,
          'bot.maxLengthResponse': 200,
          'bot.personality': 'default',
          'openai.model': 'modelo-de-prueba',
          'openai.apiKey': 'k',
          'openai.baseURL': 'http://localhost',
        };
        return valores[clave];
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: ConfigService, useValue: config },
        { provide: ContextService, useValue: context },
        { provide: UsageService, useValue: usage },
        { provide: MemoryService, useValue: { getMemory: jest.fn().mockResolvedValue([]), saveMemory: jest.fn() } },
        { provide: LoggingService, useValue: { getLastMessages: jest.fn().mockResolvedValue([{ user: 'Nico', message: 'hola' }]) } },
        { provide: PromptBuilderService, useValue: builder },
        { provide: IntentRouterService, useValue: router },
      ],
    }).compile();

    service = moduleRef.get<ChatService>(ChatService);
  });

  /** La instrumentación es fire-and-forget: hay que dejar correr la microtask. */
  const dejarCorrer = () => new Promise((r) => setImmediate(r));

  it('registra el uso de chat() con kind "chat" y el usuario', async () => {
    crearMock.mockResolvedValue(respuesta('hola!', 1800, 42));

    await service.chat('hola', 'Aria', 'Nico');
    await dejarCorrer();

    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'chat', user: 'Nico', promptTokens: 1800, completionTokens: 42 }),
    );
  });

  it('registra el uso de translateToSpanish() con kind "translate"', async () => {
    crearMock.mockResolvedValue(respuesta('traducido', 300, 250));

    await service.translateToSpanish('some text');
    await dejarCorrer();

    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'translate', promptTokens: 300, completionTokens: 250 }),
    );
  });

  it('registra el uso de generateSummary() con kind "summary"', async () => {
    crearMock.mockResolvedValue(respuesta('resumen', 900, 400));

    await service.generateSummary();
    await dejarCorrer();

    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'summary', promptTokens: 900, completionTokens: 400 }),
    );
  });

  it('registra 0 tokens cuando el proveedor no devuelve usage', async () => {
    crearMock.mockResolvedValue({ choices: [{ message: { content: 'hola' } }] });

    await service.chat('hola', 'Aria', 'Nico');
    await dejarCorrer();

    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'chat', promptTokens: 0, completionTokens: 0 }),
    );
  });

  it('no registra nada cuando la llamada al modelo falla', async () => {
    crearMock.mockRejectedValue(new Error('502'));

    const salida = await service.chat('hola', 'Aria', 'Nico');
    await dejarCorrer();

    expect(salida).toContain('error');
    expect(usage.record).not.toHaveBeenCalled();
  });

  it('devuelve la respuesta aunque el registro de uso falle', async () => {
    crearMock.mockResolvedValue(respuesta('hola!'));
    usage.record.mockRejectedValue(new Error('mongo caído'));

    const salida = await service.chat('hola', 'Aria', 'Nico');
    await dejarCorrer();

    expect(salida).toContain('hola');
  });

  it('pide el contexto del usuario que habla, no el global', async () => {
    crearMock.mockResolvedValue(respuesta('hola!'));

    await service.chat('hola', 'Aria', 'Nico');

    expect(context.getForUser).toHaveBeenCalledWith('Nico');
  });

  it('rutea el mensaje y arma el prompt sólo con los bloques que devolvió el router', async () => {
    router.route.mockResolvedValue(['PERSONA', 'TEMPORAL']);
    crearMock.mockResolvedValue(respuesta('hola!'));

    await service.chat('hola', 'Aria', 'Nico');

    expect(router.route).toHaveBeenCalledWith('hola', expect.objectContaining({ username: 'Nico' }));
    expect(builder.build).toHaveBeenCalledWith(
      expect.objectContaining({ blocks: ['PERSONA', 'TEMPORAL'] }),
    );
  });

  it('registra los bloques usados en intents, junto a las etiquetas de la fase 2', async () => {
    router.route.mockResolvedValue(['PERSONA', 'TEMPORAL', 'ANILIST']);
    crearMock.mockResolvedValue(respuesta('va!'));

    await service.chat('qué tal berserk', 'Aria', 'Nico');
    await dejarCorrer();

    const registrado = usage.record.mock.calls[0][0];
    expect(registrado.intents).toEqual(expect.arrayContaining(['ANILIST', 'persona:default']));
  });

  it('usa isSimpleGreeting del router (fuente única) para el tratamiento de saludo', async () => {
    // Antes chat.service.ts sostenía su propia regex de saludo, más angosta
    // que la del router — "hey bot" era saludo para el router pero no para
    // esta clase. Ahora delega en `intentRouter.isSimpleGreeting`.
    router.isSimpleGreeting.mockReturnValue(true);
    crearMock.mockResolvedValue(respuesta('hola!'));

    await service.chat('hey bot', 'Aria', 'Nico');

    expect(router.isSimpleGreeting).toHaveBeenCalledWith('hey bot');
    expect(crearMock).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.3, max_tokens: 50 }),
    );
  });

  it('no aplica el tratamiento de saludo cuando el router dice que no lo es', async () => {
    router.isSimpleGreeting.mockReturnValue(false);
    crearMock.mockResolvedValue(respuesta('respuesta normal'));

    await service.chat('cuéntame de vinland saga', 'Aria', 'Nico');

    expect(crearMock).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.7 }),
    );
  });

  it('si el router falla, arma el prompt completo en vez de quedarse sin bloques', async () => {
    router.route.mockRejectedValue(new Error('mongo caído'));
    crearMock.mockResolvedValue(respuesta('hola!'));

    await service.chat('qué tal berserk', 'Aria', 'Nico');

    expect(builder.build).toHaveBeenCalledWith(
      expect.objectContaining({ blocks: expect.arrayContaining(['ANILIST', 'MUSIC']) }),
    );
  });
});
