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
import { MemoryStore } from '../memory/memory-store.service';
import { MemorySettingsService } from '../memory/memory-settings.service';
import { EmbeddingService } from '../memory/embedding.service';

interface Dispatcher {
  handleNewChatMessage(msg: ChatMessage): Promise<void>;
}

const MEMORIES = [
  { _id: 'a', kind: 'event', text: 'Rinde el examen de cálculo', eventDate: '2026-11-27', eventTime: null },
  { _id: 'b', kind: 'fact', text: 'Su gato se llama Michi', eventDate: null, eventTime: null },
];

async function build(opts: { memories?: unknown[]; facts?: unknown[]; enabled?: boolean } = {}) {
  const events: string[] = [];
  const socket = {
    onMessage: jest.fn(),
    getReplyContext: jest.fn().mockReturnValue(null),
    sendMessage: jest.fn((t: string) => events.push(t.replace(/^\^#\w+ /, ''))),
    sendMessageAndAwaitId: jest.fn().mockResolvedValue(null),
    getOnlineUsers: jest.fn().mockResolvedValue([]),
    username: 'Aria',
    isConnected: true,
  };
  const store = {
    listActive: jest.fn().mockResolvedValue(opts.memories ?? MEMORIES),
    countActive: jest.fn().mockResolvedValue((opts.memories ?? MEMORIES).length),
    forgetByPosition: jest.fn(async (_u: string, n: number) => (opts.memories ?? MEMORIES)[n - 1] ?? null),
    forgetAll: jest.fn().mockResolvedValue((opts.memories ?? MEMORIES).length),
  };
  let override: boolean | null = null;
  const settings = {
    isEnabled: () => (override ?? opts.enabled ?? true),
    setOverride: jest.fn((v: boolean | null) => (override = v)),
    getInfo: () => ({ enabled: override ?? opts.enabled ?? true, source: override === null ? 'env' : 'override' }),
  };
  const embeddings = { currentSource: jest.fn().mockReturnValue('external') };
  const graphUser = {
    describe: jest.fn().mockResolvedValue(opts.facts ?? []),
    countForgettableAll: jest.fn().mockResolvedValue(3),
    forgetAll: jest.fn().mockResolvedValue(3),
  };
  const usage = {
    summarize: jest.fn().mockResolvedValue({
      calls: 10, promptTokens: 1000, cachedPromptTokens: 0, completionTokens: 100, topUsers: [], oldest: null, latency: null, embeddingCalls: 4,
    }),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      BotService,
      BotOutputService,
      BotCommandsService,
      { provide: ConfigService, useValue: { get: jest.fn() } },
      { provide: ChatService, useValue: { chat: jest.fn(), getSharedContextInfo: () => ({ enabled: true }) } },
      { provide: MusicService, useValue: {} },
      { provide: AniListService, useValue: {} },
      { provide: UtilsService, useValue: { sleep: jest.fn().mockResolvedValue(undefined), splitMessageIntoParts: (t: string) => [t] } },
      { provide: LoggingService, useValue: { saveLog: jest.fn().mockResolvedValue(undefined) } },
      { provide: ChatSocketService, useValue: socket },
      { provide: GraphIngestService, useValue: { ingestSocial: jest.fn().mockResolvedValue(undefined) } },
      { provide: GraphCacheService, useValue: {} },
      { provide: GraphService, useValue: {} },
      { provide: GraphUserService, useValue: graphUser },
      { provide: UsageService, useValue: usage },
      { provide: RateLimitService, useValue: { check: jest.fn().mockReturnValue(true) } },
      { provide: CrossContextSettingsService, useValue: { isEnabled: () => false, getInfo: () => ({ enabled: false, source: 'env' }) } },
      { provide: ErrandService, useValue: { claimNext: jest.fn().mockResolvedValue(null), setBotName: jest.fn() } },
      { provide: StickerCatalogService, useValue: new StickerCatalogService() },
      { provide: StickerGateService, useValue: {} },
      { provide: MemoryStore, useValue: store },
      { provide: MemorySettingsService, useValue: settings },
      { provide: EmbeddingService, useValue: embeddings },
    ],
  }).compile();
  moduleRef.get(BotCommandsService).probeService = async (name: string) => ({ name, ok: true, status: 200, ms: 1 }) as never;

  const service = moduleRef.get(BotService) as unknown as Dispatcher;
  const send = (content: string, role = 'user') =>
    service.handleNewChatMessage({
      _id: 'x', content, authorUsername: 'Victoria', authorRole: role, type: 'text', createdAt: new Date().toISOString(), replyTo: null,
    } as ChatMessage);
  return { send, events, store, settings, embeddings, graphUser };
}

describe('Comandos de la memoria a largo plazo', () => {
  it('!quesabes sin hechos del grafo pero con recuerdos los muestra numerados', async () => {
    const { send, events } = await build();
    await send('!quesabes');
    const text = events.join('\n');
    expect(text).not.toContain('Todavía no tengo nada');
    expect(text).toContain('🧠 Lo que recuerdo:');
    expect(text).toContain('1. Rinde el examen de cálculo (viernes 27/11)');
    expect(text).toContain('2. Su gato se llama Michi');
  });

  it('!quesabes sin nada sigue diciendo que no tiene nada', async () => {
    const { send, events } = await build({ memories: [] });
    await send('!quesabes');
    expect(events.join('\n')).toContain('Todavía no tengo nada guardado sobre vos');
  });

  it('!olvida recuerdo 2 borra ese y lo dice', async () => {
    const { send, events, store } = await build();
    await send('!olvida recuerdo 2');
    expect(store.forgetByPosition).toHaveBeenCalledWith('Victoria', 2);
    expect(events.join('\n')).toContain('Su gato se llama Michi');
  });

  it('!olvida recuerdo con un número que no existe avisa', async () => {
    const { send, events } = await build();
    await send('!olvida recuerdo 9');
    expect(events.join('\n')).toMatch(/No tengo un recuerdo número 9/);
  });

  it('!olvida todo cuenta grafo + recuerdos y !olvida todo si borra los dos', async () => {
    const { send, events, store, graphUser } = await build();
    await send('!olvida todo');
    expect(events.join('\n')).toContain('borraría 5 cosas');
    await send('!olvida todo si');
    expect(graphUser.forgetAll).toHaveBeenCalledWith('Victoria');
    expect(store.forgetAll).toHaveBeenCalledWith('Victoria');
    expect(events.join('\n')).toContain('borré 5 cosas');
  });

  it('!memoria es sólo para admins', async () => {
    const { send, events, settings } = await build();
    await send('!memoria on', 'user');
    expect(settings.setOverride).not.toHaveBeenCalled();
    expect(events.join('\n')).toContain('Solo admins');
  });

  it('!memoria on|off|reset|status', async () => {
    const { send, events, settings, embeddings } = await build({ enabled: false });
    await send('!memoria on', 'admin');
    expect(settings.setOverride).toHaveBeenLastCalledWith(true);
    await send('!memoria status', 'admin');
    expect(events[events.length - 1]).toContain('encendida');
    expect(events[events.length - 1]).toContain('override');
    expect(events[events.length - 1]).toContain('externa');
    embeddings.currentSource.mockReturnValue('keywords');
    await send('!memoria', 'superAdmin');
    expect(events[events.length - 1]).toContain('palabras clave');
    await send('!memoria off', 'admin');
    expect(settings.setOverride).toHaveBeenLastCalledWith(false);
    await send('!memoria reset', 'admin');
    expect(settings.setOverride).toHaveBeenLastCalledWith(null);
    expect(events[events.length - 1]).toContain('apagada');
  });

  it('!estado dice si la memoria está encendida y con qué fuente', async () => {
    const { send, events } = await build();
    await send('!estado', 'admin');
    expect(events.join('\n')).toContain('memoria sí (externa)');
  });

  it('!estado con la memoria apagada', async () => {
    const { send, events } = await build({ enabled: false });
    await send('!estado', 'admin');
    expect(events.join('\n')).toContain('memoria no');
  });

  it('!ayuda lista !olvida recuerdo a todos y !memoria a los admins', async () => {
    const { send, events } = await build();
    await send('!ayuda');
    expect(events.join('\n')).toContain('!olvida recuerdo <n>');
    expect(events.join('\n')).not.toContain('!memoria on');
    events.length = 0;
    await send('!ayuda', 'admin');
    expect(events.join('\n')).toContain('!memoria on|off|reset|status');
  });

  it('!uso muestra las llamadas de embeddings aparte', async () => {
    const { send, events } = await build();
    await send('!uso', 'admin');
    expect(events.join('\n')).toContain('Embeddings: 4 llamadas');
  });
});
