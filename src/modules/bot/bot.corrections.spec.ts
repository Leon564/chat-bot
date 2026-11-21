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
import { MusicQuotaService } from './music-quota.service';
import { MusicIntentService } from './music-intent.service';

/**
 * Correcciones 1–3 del roadmap: el handler del socket no tumba el proceso, la
 * música no se dispara con charla normal, y la música tiene topes.
 */
const build = async (opts: { quota?: boolean; config?: Record<string, unknown> } = {}) => {
  const sent: string[] = [];
  let handler: ((msg: ChatMessage) => void) | null = null;
  const socket = {
    onMessage: jest.fn((h: (msg: ChatMessage) => void) => {
      handler = h;
    }),
    getReplyContext: jest.fn().mockReturnValue(null),
    sendMessage: jest.fn((t: string) => sent.push(t)),
    sendMessageAndAwaitId: jest.fn().mockResolvedValue('buscando-id'),
    deleteMessage: jest.fn(),
    getOnlineUsers: jest.fn().mockResolvedValue([{ username: 'kei', role: 'user', isActive: true }]),
    username: 'Aria',
  };
  // Pedido de música que no termina hasta que el test lo resuelva.
  const pendingMusic: Array<() => void> = [];
  const music = {
    processMusic: jest.fn(
      () =>
        new Promise((resolve) => {
          pendingMusic.push(() => resolve({ text: 'listo', track: null, media: null }));
        }),
    ),
    processVideo: jest.fn(),
    getQueueStatus: jest.fn(),
  };
  const chat = { chat: jest.fn().mockResolvedValue('') };
  const logging = { saveLog: jest.fn().mockResolvedValue(undefined) };
  const config: Record<string, unknown> = { 'music.perHour': 5, 'music.perHourRegistered': 20, ...opts.config };

  const moduleRef = await Test.createTestingModule({
    providers: [
      BotService,
      BotOutputService,
      BotCommandsService,
      { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
      { provide: ChatService, useValue: chat },
      { provide: MusicService, useValue: music },
      { provide: AniListService, useValue: {} },
      { provide: UtilsService, useValue: { sleep: jest.fn().mockResolvedValue(undefined) } },
      { provide: LoggingService, useValue: logging },
      { provide: ChatSocketService, useValue: socket },
      {
        provide: GraphIngestService,
        useValue: { ingestSocial: jest.fn().mockResolvedValue(undefined), ingestTrack: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: GraphCacheService, useValue: {} },
      {
        provide: GraphService,
        useValue: {
          findNode: jest.fn().mockResolvedValue(null),
          // El grafo conoce a Yorushika (para el clasificador de "reproduce X").
          resolveByAlias: jest.fn(async (alias: string) =>
            alias.trim().toLowerCase() === 'yorushika' ? { type: 'artist', label: 'Yorushika' } : null,
          ),
        },
      },
      { provide: GraphUserService, useValue: {} },
      { provide: UsageService, useValue: {} },
      { provide: RateLimitService, useValue: { check: () => true, shouldNotifyRejection: () => true } },
      { provide: CrossContextSettingsService, useValue: { isEnabled: () => false } },
      { provide: ErrandService, useValue: { claimNext: jest.fn().mockResolvedValue(null), setBotName: jest.fn() } },
      {
        provide: StickerCatalogService,
        useValue: { size: 0, describeContent: (c: string) => c, promptList: () => '', findByName: () => null },
      },
      { provide: StickerGateService, useValue: { decide: () => 'none', markSent: () => {} } },
      ...(opts.quota === false ? [] : [MusicQuotaService]),
      MusicIntentService,
    ],
  }).compile();

  const service = moduleRef.get(BotService);
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const send = async (content: string, authorRole = 'user', authorUsername = 'nico') => {
    await service['handleNewChatMessage']({ _id: 'm', content, authorUsername, authorRole } as ChatMessage);
    await flush();
  };
  return { service, socket, sent, music, chat, logging, send, flush, pendingMusic, getHandler: () => handler };
};

describe('1. un error manejando un mensaje no tumba el proceso', () => {
  it('el handler registrado en el socket captura y loguea el rechazo', async () => {
    const { service, logging, getHandler, flush } = await build();
    await service.onModuleInit();
    logging.saveLog.mockRejectedValue(new Error('Mongo parpadeó'));
    const logError = jest.spyOn(service['logger'], 'error').mockImplementation(() => {});

    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      getHandler()!({ _id: 'm', content: 'hola', authorUsername: 'nico', authorRole: 'user' } as ChatMessage);
      await flush();
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Mongo parpadeó'), expect.any(String));
  });
});

describe('2. la música no se dispara con charla normal', () => {
  it.each([
    'el tema de hoy es el torneo',
    'me encanta la música de ese anime',
    'quién reproduce el video?',
    'quiero escuchar tu opinión',
  ])('"%s" (sin nombrar al bot) no pide música', async (content) => {
    const { send, music, chat } = await build();
    await send(content);
    expect(music.processMusic).not.toHaveBeenCalled();
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('"!music X" funciona sin nombrar al bot', async () => {
    const { send, music } = await build();
    await send('!music yorushika');
    expect(music.processMusic).toHaveBeenCalledWith('yorushika', 'nico', expect.anything());
  });

  it('una frase natural con el bot nombrado va por el camino rápido', async () => {
    const { send, music } = await build();
    await send('Aria reproduce ita song');
    expect(music.processMusic).toHaveBeenCalledWith('ita song', 'nico', expect.anything());
  });

  it('"bot, la música de X" ya no va por el camino rápido: la decide el modelo', async () => {
    const { send, music, chat } = await build();
    await send('bot qué opinás de la música de Evangelion?');
    expect(music.processMusic).not.toHaveBeenCalled();
    expect(chat.chat).toHaveBeenCalled();
  });
});

describe('3. la música tiene topes', () => {
  it('un tercer pedido en camino de la misma persona se rechaza con aviso', async () => {
    const { send, music, sent } = await build();
    await send('!music aaa');
    await send('!music bbb');
    await send('!music ccc');

    expect(music.processMusic).toHaveBeenCalledTimes(2);
    expect(sent.join(' ')).toContain('Ya tenés 2 pedidos en camino');
  });

  it('al terminar un pedido se libera el lugar', async () => {
    const { send, music, pendingMusic, flush } = await build();
    await send('!music aaa');
    await send('!music bbb');
    pendingMusic[0]();
    await flush();
    await send('!music ccc');
    expect(music.processMusic).toHaveBeenCalledTimes(3);
  });

  it('el cupo por hora de invitados aplica también a los {{music:}} del modelo', async () => {
    const { send, music, chat, sent, pendingMusic, flush } = await build({ config: { 'music.perHour': 1 } });
    await send('!music aaa', 'guest', 'invitado');
    pendingMusic[0]();
    await flush();

    chat.chat.mockResolvedValue('¡Va! {{music:otra}}');
    await send('bot pasame otra', 'guest', 'invitado');

    expect(music.processMusic).toHaveBeenCalledTimes(1);
    expect(sent.join(' ')).toContain('tope de 1 pedidos por hora');
  });

  it('sin el servicio (tests armados a mano) no hay topes', async () => {
    const { send, music } = await build({ quota: false });
    for (const q of ['aaa', 'bbb', 'ccc', 'ddd']) await send(`!music ${q}`);
    expect(music.processMusic).toHaveBeenCalledTimes(4);
  });
});

describe('2b. "reproduce X" sin nombrar al bot, con el clasificador local', () => {
  it('un pedido claro al principio del mensaje se atiende', async () => {
    const { send, music } = await build();
    await send('reproduce lemon de kenshi yonezu');
    expect(music.processMusic).toHaveBeenCalledWith('lemon de kenshi yonezu', 'nico', expect.anything());
  });

  it('un verbo ambiguo pasa si el grafo conoce al artista', async () => {
    const { send, music } = await build();
    await send('pon yorushika');
    expect(music.processMusic).toHaveBeenCalledWith('yorushika', 'nico', expect.anything());
  });

  it.each(['pon atención', 'reproduce el video de ayer', 'reproduce eso otra vez?'])(
    '"%s" no pide música ni llama al modelo',
    async (content) => {
      const { send, music, chat } = await build();
      await send(content);
      expect(music.processMusic).not.toHaveBeenCalled();
      expect(chat.chat).not.toHaveBeenCalled();
    },
  );

  it('respeta los topes de música igual que !music', async () => {
    const { send, music, sent } = await build({ config: { 'music.perHour': 1 } });
    await send('reproduce lemon', 'guest', 'invitado');
    await send('reproduce unravel', 'guest', 'invitado');
    expect(music.processMusic).toHaveBeenCalledTimes(1);
    expect(sent.join(' ')).toContain('tope de 1 pedidos por hora');
  });
});

describe('lista de conectados: las preguntas ambiguas exigen nombrar al bot', () => {
  it.each([
    '¿quién está en línea?',
    'cuántos hay conectados?',
    'quienes estan online',
    "who's online",
    'quién más está por aquí?',
  ])('"%s" (nombra la presencia en el chat) la pide sin mención', async (content) => {
    const { send, socket } = await build();
    await send(content);
    expect(socket.getOnlineUsers).toHaveBeenCalled();
  });

  it.each(['¿cuántas personas fueron al concierto?', 'la gente activa del gym', 'cuantos hay que pagar?'])(
    '"%s" sin nombrar al bot no la pide',
    async (content) => {
      const { send, socket, chat } = await build();
      await send(content);
      expect(socket.getOnlineUsers).not.toHaveBeenCalled();
      expect(chat.chat).not.toHaveBeenCalled();
    },
  );

  it('la misma pregunta ambigua nombrando al bot sí la pide', async () => {
    const { send, socket } = await build();
    await send('Aria cuántas personas hay?');
    expect(socket.getOnlineUsers).toHaveBeenCalled();
  });
});
