import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BotOutputService } from './bot-output.service';
import { BotCommandsService } from './bot-commands.service';
import { BotService } from './bot.service';
import { ChatService } from '../chat/chat.service';
import { MusicService } from '../music/music.service';
import { AniListService } from '../anilist/anilist.service';
import { UtilsService } from '../../common/utils/utils.service';
import { LoggingService } from '../../common/utils/logging.service';
import { ChatSocketService, ChatMessage } from '../chat-socket/chat-socket.service';
import { GraphIngestService } from '../graph/graph-ingest.service';
import { GraphCacheService } from '../graph/graph-cache.service';
import { GraphService } from '../graph/graph.service';
import { GraphUserService } from '../graph/graph-user.service';
import { UsageService } from '../chat/usage.service';
import { RateLimitService } from './rate-limit.service';
import { CrossContextSettingsService } from '../../common/settings/cross-context-settings.service';
import { ErrandService } from '../graph/errand.service';
import { StickerCatalogService } from '../chat-socket/sticker-catalog.service';
import { StickerGateService } from './sticker-gate.service';
import { FollowupService } from '../memory/followup.service';
import { MemorySettingsService } from '../memory/memory-settings.service';

interface Dispatcher {
  handleNewChatMessage(msg: ChatMessage): Promise<void>;
  deliverDueReminders(now?: Date): Promise<void>;
}

const EXAM = { _id: 'm1', kind: 'event', text: 'Rinde el examen de cálculo', eventDate: '2026-11-27' };

async function build(opts: { enabled?: boolean; after?: unknown; before?: unknown[]; drafted?: string } = {}) {
  const events: string[] = [];
  const socket = {
    onMessage: jest.fn(),
    getReplyContext: jest.fn().mockReturnValue(null),
    sendMessage: jest.fn((t: string) => events.push(`text:${t}`)),
    sendMessageAndAwaitId: jest.fn().mockResolvedValue(null),
    getOnlineUsers: jest.fn().mockResolvedValue([]),
    username: 'Aria',
  };
  const chat = {
    chat: jest.fn().mockResolvedValue('todo bien'),
    deliverErrand: jest.fn(),
    draftFollowUp: jest.fn().mockResolvedValue(opts.drafted ?? ''),
  };
  const followups = {
    claimAfter: jest.fn().mockResolvedValue(opts.after ?? null),
    claimDueBefore: jest.fn().mockResolvedValue(opts.before ?? []),
  };
  const settings = { isEnabled: jest.fn().mockReturnValue(opts.enabled ?? true) };
  const logging = { saveLog: jest.fn().mockResolvedValue(undefined) };

  const moduleRef = await Test.createTestingModule({
    providers: [
      BotService,
      BotOutputService,
      BotCommandsService,
      { provide: ConfigService, useValue: { get: jest.fn() } },
      { provide: ChatService, useValue: chat },
      { provide: MusicService, useValue: {} },
      { provide: AniListService, useValue: {} },
      { provide: UtilsService, useValue: { sleep: jest.fn().mockResolvedValue(undefined), splitMessageIntoParts: (t: string) => [t] } },
      { provide: LoggingService, useValue: logging },
      { provide: ChatSocketService, useValue: socket },
      { provide: GraphIngestService, useValue: { ingestSocial: jest.fn().mockResolvedValue(undefined) } },
      { provide: GraphCacheService, useValue: {} },
      { provide: GraphService, useValue: { findNode: jest.fn().mockResolvedValue(null), collaborative: jest.fn().mockResolvedValue([]) } },
      { provide: GraphUserService, useValue: {} },
      { provide: UsageService, useValue: {} },
      { provide: RateLimitService, useValue: { check: jest.fn().mockReturnValue(true) } },
      {
        provide: CrossContextSettingsService,
        useValue: { isEnabled: () => false, getInfo: () => ({ enabled: false, source: 'env' }) },
      },
      { provide: ErrandService, useValue: { claimNext: jest.fn().mockResolvedValue(null), setBotName: jest.fn() } },
      { provide: StickerCatalogService, useValue: new StickerCatalogService() },
      { provide: StickerGateService, useValue: { decide: jest.fn().mockReturnValue('none'), markSent: jest.fn() } },
      { provide: FollowupService, useValue: followups },
      { provide: MemorySettingsService, useValue: settings },
    ],
  }).compile();

  const service = moduleRef.get(BotService) as unknown as Dispatcher;
  const send = (content: string, role = 'user') =>
    service.handleNewChatMessage({
      _id: 'm1',
      content,
      authorUsername: 'Victoria',
      authorRole: role,
      type: 'text',
      createdAt: new Date().toISOString(),
      replyTo: null,
    } as ChatMessage);
  return { service, send, events, chat, followups, settings, logging };
}

describe('BotService — memoria a largo plazo', () => {
  it('a un invitado no le pasa memoria ni le busca seguimientos', async () => {
    const { send, chat, followups } = await build();
    await send('bot hola', 'guest');
    expect(chat.chat).toHaveBeenCalledWith('bot hola', 'Aria', 'Victoria');
    expect(followups.claimAfter).not.toHaveBeenCalled();
  });

  it('a un registrado le pasa memoria vacía', async () => {
    const { send, chat } = await build();
    await send('bot hola');
    expect(chat.chat).toHaveBeenCalledWith('bot hola', 'Aria', 'Victoria', { memory: {} });
  });

  it('con la memoria apagada no hay memoria ni seguimientos', async () => {
    const { send, chat, followups, service } = await build({ enabled: false, before: [{ user: 'Victoria', memory: EXAM }] });
    await send('bot hola');
    await send('hola gente');
    await service.deliverDueReminders(new Date());
    expect(chat.chat).toHaveBeenCalledWith('bot hola', 'Aria', 'Victoria');
    expect(followups.claimAfter).not.toHaveBeenCalled();
    expect(followups.claimDueBefore).not.toHaveBeenCalled();
  });

  it('si le habla al bot con un después pendiente, va DENTRO de la respuesta (un solo mensaje)', async () => {
    const { send, chat, events } = await build({ after: EXAM });
    await send('bot hola');
    expect(chat.chat).toHaveBeenCalledWith('bot hola', 'Aria', 'Victoria', {
      memory: { followUp: 'Rinde el examen de cálculo' },
    });
    expect(chat.draftFollowUp).not.toHaveBeenCalled();
    expect(events).toEqual(['text:<@Victoria> todo bien']);
  });

  it('si no le habla al bot, el después sale como mensaje propio', async () => {
    const { send, chat, events, logging } = await build({ after: EXAM, drafted: '¡Ey! ¿Cómo te fue en el examen? 🙌' });
    await send('hola gente');
    expect(chat.chat).not.toHaveBeenCalled();
    expect(chat.draftFollowUp).toHaveBeenCalledWith('Aria', 'Victoria', 'Rinde el examen de cálculo', 'after');
    expect(events).toEqual(['text:<@Victoria> ¡Ey! ¿Cómo te fue en el examen? 🙌']);
    expect(logging.saveLog).toHaveBeenCalledWith('Aria', expect.stringContaining('¿Cómo te fue en el examen?'));
  });

  it('sin hablarle, sólo reclama "después" que no sean delicados', async () => {
    const { send, followups } = await build({ after: EXAM });
    await send('hola gente');
    expect(followups.claimAfter).toHaveBeenCalledWith('Victoria', expect.any(Date), { includeSensitive: false });
  });

  it('si el modelo no redacta el después, sale el texto fijo', async () => {
    const { send, events } = await build({ after: EXAM, drafted: '' });
    await send('hola gente');
    expect(events).toEqual(['text:<@Victoria> ¿cómo te fue con lo de rinde el examen de cálculo?']);
  });

  it('sin después pendiente, un mensaje que no le habla no manda nada', async () => {
    const { send, events, chat } = await build();
    await send('hola gente');
    expect(events).toEqual([]);
    expect(chat.draftFollowUp).not.toHaveBeenCalled();
  });

  it('el tick manda la suerte del día con la voz de Aria', async () => {
    const { service, events, chat } = await build({
      before: [{ user: 'Victoria', memory: EXAM }],
      drafted: '¡Hoy es el examen! Mucha suerte 🍀',
    });
    await service.deliverDueReminders(new Date());
    expect(chat.draftFollowUp).toHaveBeenCalledWith('Aria', 'Victoria', 'Rinde el examen de cálculo', 'before');
    expect(events).toEqual(['text:<@Victoria> ¡Hoy es el examen! Mucha suerte 🍀']);
  });

  it('si el modelo no redacta la suerte, sale el texto fijo', async () => {
    const { service, events } = await build({ before: [{ user: 'Victoria', memory: EXAM }], drafted: '' });
    await service.deliverDueReminders(new Date());
    expect(events).toEqual(['text:<@Victoria> ¡hoy es el día! Suerte con lo de rinde el examen de cálculo 🍀']);
  });
});
