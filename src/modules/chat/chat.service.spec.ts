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

const respuesta = (content: string, prompt = 100, completion = 20) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: prompt, completion_tokens: completion },
});

describe('ChatService — instrumentación de tokens', () => {
  let service: ChatService;
  let usage: { record: jest.Mock };
  let context: { getForUser: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    crearMock.mockReset();
    usage = { record: jest.fn().mockResolvedValue(undefined) };
    context = {
      getForUser: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
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
});
