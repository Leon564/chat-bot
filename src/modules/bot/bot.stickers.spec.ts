import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BotService } from './bot.service';
import { ChatService } from '../chat/chat.service';
import { MusicService } from '../music/music.service';
import { AniListService } from '../anilist/anilist.service';
import { UtilsService } from '../../common/utils/utils.service';
import { LoggingService } from '../../common/utils/logging.service';
import { MemoryService } from '../../common/utils/memory.service';
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
import { StickerGateService, StickerOffer } from './sticker-gate.service';

interface Dispatcher {
  handleNewChatMessage(msg: ChatMessage): Promise<void>;
}

const STICKERS = [
  { _id: '1', name: 'Gato llorando', code: 'stk_gato1', categoryId: 'c1' },
  { _id: '2', name: 'Pepe hacker', code: 'stk_pepe1', categoryId: 'c2' },
];
const CATS = [
  { _id: 'c1', name: 'Animalitos', order: 0 },
  { _id: 'c2', name: 'Pepe', order: 1 },
];

async function build(decision: StickerOffer, modelReply: string) {
  const events: string[] = [];
  const socket = {
    onMessage: jest.fn(),
    getReplyContext: jest.fn().mockReturnValue(null),
    sendMessage: jest.fn((t: string) => events.push(`text:${t}`)),
    sendSticker: jest.fn((code: string) => events.push(`sticker:${code}`)),
    sendMessageAndAwaitId: jest.fn().mockResolvedValue(null),
    getOnlineUsers: jest.fn().mockResolvedValue([]),
    username: 'Aria',
  };
  const catalog = new StickerCatalogService();
  catalog.update(STICKERS, CATS);
  const gate = { decide: jest.fn().mockReturnValue(decision), markSent: jest.fn() };
  const chat = { chat: jest.fn().mockResolvedValue(modelReply), deliverErrand: jest.fn() };

  const moduleRef = await Test.createTestingModule({
    providers: [
      BotService,
      { provide: ConfigService, useValue: { get: jest.fn() } },
      { provide: ChatService, useValue: chat },
      { provide: MusicService, useValue: {} },
      { provide: AniListService, useValue: {} },
      { provide: UtilsService, useValue: { sleep: jest.fn().mockResolvedValue(undefined), splitMessageIntoParts: (t: string) => [t] } },
      { provide: LoggingService, useValue: { saveLog: jest.fn().mockResolvedValue(undefined) } },
      { provide: MemoryService, useValue: {} },
      { provide: ChatSocketService, useValue: socket },
      { provide: GraphIngestService, useValue: { ingestSocial: jest.fn().mockResolvedValue(undefined) } },
      { provide: GraphCacheService, useValue: {} },
      {
        provide: GraphService,
        useValue: { findNode: jest.fn().mockResolvedValue(null), collaborative: jest.fn().mockResolvedValue([]) },
      },
      { provide: GraphUserService, useValue: {} },
      { provide: UsageService, useValue: {} },
      { provide: RateLimitService, useValue: { check: jest.fn().mockReturnValue(true) } },
      {
        provide: CrossContextSettingsService,
        useValue: { isEnabled: () => false, getInfo: () => ({ enabled: false, source: 'env' }) },
      },
      { provide: ErrandService, useValue: { claimNext: jest.fn().mockResolvedValue(null), setBotName: jest.fn() } },
      { provide: StickerCatalogService, useValue: catalog },
      { provide: StickerGateService, useValue: gate },
    ],
  }).compile();

  const service = moduleRef.get(BotService) as unknown as Dispatcher;
  const send = (content: string, type: 'text' | 'sticker' = 'text') =>
    service.handleNewChatMessage({
      _id: 'm1',
      content,
      authorUsername: 'Nico',
      authorRole: 'user',
      type,
      createdAt: new Date().toISOString(),
      replyTo: type === 'sticker' ? { messageId: 'x', authorUsername: 'Aria', authorColor: '', contentExcerpt: '' } : null,
    });
  return { send, events, chat, gate, socket };
}

describe('BotService — stickers', () => {
  it('sin oferta no le pasa la lista al modelo', async () => {
    const { send, chat } = await build('none', 'todo bien');
    await send('bot cómo va');
    expect(chat.chat).toHaveBeenCalledWith('bot cómo va', 'Aria', 'Nico');
  });

  it('con oferta pasa la lista agrupada y si fue pedido explícito', async () => {
    const { send, chat } = await build('requested', 'ahí va {{sticker:Gato llorando}}');
    await send('bot mandame un sticker');
    expect(chat.chat).toHaveBeenCalledWith('bot mandame un sticker', 'Aria', 'Nico', {
      stickers: { list: 'Animalitos: Gato llorando\nPepe: Pepe hacker', requested: true },
    });
  });

  it('manda el texto y DESPUÉS el sticker, y consume el cooldown', async () => {
    const { send, events, gate } = await build('optional', 'jaja pobre {{sticker:gato LLORANDO}}');
    await send('bot se me cayó el helado');
    expect(events).toEqual(['text:<@Nico> jaja pobre', 'sticker:stk_gato1']);
    expect(gate.markSent).toHaveBeenCalledTimes(1);
  });

  it('una respuesta que es sólo el sticker no manda texto vacío', async () => {
    const { send, events } = await build('requested', '{{sticker:Pepe hacker}}');
    await send('bot un sticker');
    expect(events).toEqual(['sticker:stk_pepe1']);
  });

  it('un nombre que no existe no manda sticker ni consume el cooldown', async () => {
    const { send, events, gate } = await build('optional', 'dale {{sticker:Perro bailando}}');
    await send('bot hola');
    expect(events).toEqual(['text:<@Nico> dale']);
    expect(gate.markSent).not.toHaveBeenCalled();
  });

  it('describe al modelo un sticker recibido por su nombre', async () => {
    const { send, chat } = await build('none', 'jaja');
    await send(':stk_gato1:', 'sticker');
    expect(chat.chat.mock.calls[0][0]).toBe('[sticker: Gato llorando]');
  });
});
