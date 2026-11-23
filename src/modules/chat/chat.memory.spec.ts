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
import { MemoryRecallService } from '../memory/memory-recall.service';
import { MemoryStore } from '../memory/memory-store.service';
import { FollowupService } from '../memory/followup.service';

const respuesta = (content: string) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

const BLOCK = '[Recuerdos de Victoria — usalos sólo si vienen al caso; no los recites]\nr1 (evento, viernes 27/11): Rinde el examen';

describe('ChatService — memoria a largo plazo', () => {
  let service: ChatService;
  let context: { getForUser: jest.Mock; getShared: jest.Mock; save: jest.Mock };
  let builder: { build: jest.Mock };
  let recall: { recall: jest.Mock };
  let store: { create: jest.Mock; findOwned: jest.Mock; reschedule: jest.Mock; close: jest.Mock };
  let followups: { schedule: jest.Mock; reschedule: jest.Mock };
  let logging: { getRecent: jest.Mock };

  const memoryDoc = (over: Record<string, unknown> = {}) => ({
    _id: 'm1',
    kind: 'event',
    text: 'Rinde el examen',
    eventDate: '2026-11-27',
    ...over,
  });

  beforeEach(async () => {
    crearMock.mockReset();
    context = {
      getForUser: jest.fn().mockResolvedValue([]),
      getShared: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
    };
    builder = { build: jest.fn().mockReturnValue('system prompt') };
    recall = { recall: jest.fn().mockResolvedValue({ block: BLOCK, refs: new Map([['r1', 'm1']]) }) };
    store = {
      create: jest.fn().mockResolvedValue({ result: 'created', memory: memoryDoc() }),
      findOwned: jest.fn().mockResolvedValue(memoryDoc()),
      reschedule: jest.fn().mockResolvedValue(memoryDoc({ eventDate: '2026-11-30' })),
      close: jest.fn().mockResolvedValue(undefined),
    };
    followups = { schedule: jest.fn().mockResolvedValue(undefined), reschedule: jest.fn().mockResolvedValue(undefined) };
    logging = { getRecent: jest.fn().mockResolvedValue([{ user: 'Leon', message: 'qué onda' }]) };
    const values: Record<string, unknown> = {
      'bot.useMemory': false,
      'bot.maxLengthResponse': 200,
      'bot.personality': 'default',
      'openai.model': 'm',
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: ConfigService, useValue: { get: (k: string) => values[k] } },
        { provide: ContextService, useValue: context },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: LoggingService, useValue: logging },
        { provide: PromptBuilderService, useValue: builder },
        { provide: IntentRouterService, useValue: { route: jest.fn().mockResolvedValue(['PERSONA']), isSimpleGreeting: () => false } },
        { provide: GraphContextService, useValue: { build: jest.fn().mockResolvedValue('') } },
        { provide: GraphIngestService, useValue: { ingestFact: jest.fn(), ingestFactAbout: jest.fn() } },
        { provide: CrossContextSettingsService, useValue: { isEnabled: () => false } },
        { provide: ErrandService, useValue: { create: jest.fn() } },
        { provide: MemoryRecallService, useValue: recall },
        { provide: MemoryStore, useValue: store },
        { provide: FollowupService, useValue: followups },
      ],
    }).compile();
    service = moduleRef.get(ChatService);
  });

  const sentMessages = () => crearMock.mock.calls[0][0].messages as Array<{ role: string; content: string }>;

  it('sin options.memory no busca recuerdos, no enseña los verbos y limpia un RECUERDO sin guardarlo', async () => {
    crearMock.mockResolvedValue(respuesta('Dale! RECUERDO(dato | algo | a)'));
    const out = await service.chat('hola', 'Aria', 'Victoria');
    expect(out).toBe('Dale!');
    expect(recall.recall).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(builder.build.mock.calls[0][0].memory).toBeFalsy();
  });

  it('con options.memory el bloque va después del contexto de sala y antes del mensaje actual', async () => {
    crearMock.mockResolvedValue(respuesta('ok'));
    await service.chat('cómo va la facu', 'Aria', 'Victoria', { memory: {} });
    expect(builder.build.mock.calls[0][0].memory).toBe(true);
    const msgs = sentMessages();
    const roomIdx = msgs.findIndex((m) => m.content.includes('qué onda'));
    const memIdx = msgs.findIndex((m) => m.content === BLOCK);
    expect(roomIdx).toBeGreaterThan(0);
    expect(memIdx).toBe(roomIdx + 1);
    expect(msgs[memIdx].role).toBe('user');
    expect(msgs[msgs.length - 1].content).toBe('Victoria: cómo va la facu');
    expect(recall.recall).toHaveBeenCalledWith('Victoria', 'cómo va la facu', expect.any(Date), {});
  });

  it('con reply, recall recibe el texto del padre y el mensaje', async () => {
    crearMock.mockResolvedValue(respuesta('ok'));
    await service.chat('y vos?', 'Aria', 'Victoria', { memory: {}, replyTo: { author: 'Leon', content: 'mañana rindo' } });
    expect(recall.recall.mock.calls[0][1]).toBe('mañana rindo\ny vos?');
  });

  it('followUp llega a recall', async () => {
    crearMock.mockResolvedValue(respuesta('ok'));
    await service.chat('hola', 'Aria', 'Victoria', { memory: { followUp: 'Rinde el examen' } });
    expect(recall.recall.mock.calls[0][3]).toEqual({ followUp: 'Rinde el examen' });
  });

  it('un RECUERDO de evento se guarda y programa sus seguimientos; el texto sale limpio', async () => {
    crearMock.mockResolvedValue(respuesta('¡Suerte! RECUERDO(evento | Rinde el examen | examen, facultad | 2026-11-27 | | no)'));
    const out = await service.chat('el viernes rindo', 'Aria', 'Victoria', { memory: {} });
    expect(out).toBe('¡Suerte!');
    expect(store.create).toHaveBeenCalledWith(
      'Victoria',
      expect.objectContaining({ kind: 'event', text: 'Rinde el examen', eventDate: '2026-11-27', keywords: ['examen', 'facultad'] }),
      expect.any(Date),
    );
    expect(followups.schedule).toHaveBeenCalledWith(expect.objectContaining({ _id: 'm1' }), expect.any(Date));
    expect(context.save.mock.calls[0][0].answer).toBe('¡Suerte!');
  });

  it('si el store actualiza la fecha, reprograma en vez de programar', async () => {
    store.create.mockResolvedValue({ result: 'updated', memory: memoryDoc() });
    crearMock.mockResolvedValue(respuesta('ok RECUERDO(evento | Rinde el examen | examen | 2026-11-27)'));
    await service.chat('x', 'Aria', 'Victoria', { memory: {} });
    expect(followups.reschedule).toHaveBeenCalled();
    expect(followups.schedule).not.toHaveBeenCalled();
  });

  it('un dato no programa seguimientos; duplicate tampoco', async () => {
    store.create.mockResolvedValueOnce({ result: 'created', memory: memoryDoc({ kind: 'fact', eventDate: null }) });
    crearMock.mockResolvedValue(respuesta('ok RECUERDO(dato | Tiene un gato | gato)'));
    await service.chat('x', 'Aria', 'Victoria', { memory: {} });
    store.create.mockResolvedValueOnce({ result: 'duplicate', memory: memoryDoc() });
    await service.chat('x', 'Aria', 'Victoria', { memory: {} });
    expect(followups.schedule).not.toHaveBeenCalled();
    expect(followups.reschedule).not.toHaveBeenCalled();
  });

  it('un RECUERDO inválido no se guarda', async () => {
    crearMock.mockResolvedValue(respuesta('ok RECUERDO(chisme | algo | a)'));
    expect(await service.chat('x', 'Aria', 'Victoria', { memory: {} })).toBe('ok');
    expect(store.create).not.toHaveBeenCalled();
  });

  it('RECUERDO_CAMBIO sobre un id mostrado reprograma recuerdo y seguimientos', async () => {
    crearMock.mockResolvedValue(respuesta('Uh, al lunes entonces RECUERDO_CAMBIO(r1 | 2026-11-30)'));
    expect(await service.chat('lo pasaron al lunes', 'Aria', 'Victoria', { memory: {} })).toBe('Uh, al lunes entonces');
    expect(store.findOwned).toHaveBeenCalledWith('Victoria', 'm1');
    expect(store.reschedule).toHaveBeenCalledWith('m1', '2026-11-30', undefined);
    expect(followups.reschedule).toHaveBeenCalledWith(expect.objectContaining({ eventDate: '2026-11-30' }), expect.any(Date));
  });

  it('RECUERDO_CERRADO cierra el recuerdo', async () => {
    crearMock.mockResolvedValue(respuesta('¡Bien ahí! RECUERDO_CERRADO(r1)'));
    await service.chat('ya rendí', 'Aria', 'Victoria', { memory: {} });
    expect(store.close).toHaveBeenCalledWith('m1');
  });

  // Review Focus: id que no se mostró, o de otra persona.
  it('un id que no se mostró o que no es de esa persona no toca nada', async () => {
    crearMock.mockResolvedValue(respuesta('ok RECUERDO_CERRADO(r9) RECUERDO_CAMBIO(r9 | 2026-11-30)'));
    await service.chat('x', 'Aria', 'Victoria', { memory: {} });
    expect(store.findOwned).not.toHaveBeenCalled();
    store.findOwned.mockResolvedValue(null);
    crearMock.mockResolvedValue(respuesta('ok RECUERDO_CERRADO(r1)'));
    await service.chat('x', 'Aria', 'Victoria', { memory: {} });
    expect(store.close).not.toHaveBeenCalled();
    expect(store.reschedule).not.toHaveBeenCalled();
  });

  it('si recall falla la respuesta sale igual, sin bloque', async () => {
    recall.recall.mockRejectedValue(new Error('mongo'));
    crearMock.mockResolvedValue(respuesta('hola!'));
    expect(await service.chat('hola', 'Aria', 'Victoria', { memory: {} })).toBe('hola!');
    expect(sentMessages().some((m) => m.content.startsWith('[Recuerdos'))).toBe(false);
  });

  it('si guardar falla la respuesta sale igual', async () => {
    store.create.mockRejectedValue(new Error('mongo'));
    crearMock.mockResolvedValue(respuesta('dale RECUERDO(dato | algo | a)'));
    expect(await service.chat('x', 'Aria', 'Victoria', { memory: {} })).toBe('dale');
  });
});
