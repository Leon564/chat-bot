import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BotService } from './bot.service';
import { ChatService } from '../chat/chat.service';
import { MusicService } from '../music/music.service';
import { AniListService, AniListResult } from '../anilist/anilist.service';
import { UtilsService } from '../../common/utils/utils.service';
import { LoggingService } from '../../common/utils/logging.service';
import { MemoryService } from '../../common/utils/memory.service';
import { ChatSocketService } from '../chat-socket/chat-socket.service';
import { GraphIngestService } from '../graph/graph-ingest.service';
import { GraphCacheService } from '../graph/graph-cache.service';
import { UsageService } from '../chat/usage.service';

/**
 * `handleAniListRequest` es privado — se accede con un cast puntual, como se
 * hace con otros métodos privados en specs del repo.
 */
type BotServiceConCache = {
  handleAniListRequest(kind: string, title: string, authorUsername: string): Promise<void>;
};

describe('BotService — handleAniListRequest (caché)', () => {
  let service: BotService;
  let anilist: { search: jest.Mock };
  let chat: { translateToSpanish: jest.Mock };
  let cache: { findWork: jest.Mock; saveTranslation: jest.Mock };
  let ingest: { ingestAniList: jest.Mock; ingestSocial: jest.Mock; ingestTrack: jest.Mock };
  let socket: {
    onMessage: jest.Mock;
    sendMessage: jest.Mock;
    sendMessageAndAwaitId: jest.Mock;
    deleteMessage: jest.Mock;
    getOnlineUsers: jest.Mock;
    username: string;
  };
  let usage: { record: jest.Mock };

  const ficha: AniListResult = {
    id: 12345,
    url: 'https://anilist.co/manga/12345',
    kind: 'manhwa',
    titleRomaji: 'Solo Leveling',
    titleEnglish: null,
    coverImage: 'https://img.example/cover.jpg',
    bannerImage: null,
    score: 90,
    status: 'FINISHED',
    chapters: 200,
    volumes: null,
    episodes: null,
    genres: ['Action', 'Fantasy'],
    description: 'A weak hunter given a second chance at strength.',
    startYear: 2016,
  };

  beforeEach(async () => {
    anilist = { search: jest.fn() };
    chat = { translateToSpanish: jest.fn() };
    cache = {
      findWork: jest.fn(),
      saveTranslation: jest.fn().mockResolvedValue(undefined),
    };
    ingest = {
      ingestAniList: jest.fn().mockResolvedValue(undefined),
      ingestSocial: jest.fn().mockResolvedValue(undefined),
      ingestTrack: jest.fn().mockResolvedValue(undefined),
    };
    socket = {
      onMessage: jest.fn(),
      sendMessage: jest.fn(),
      sendMessageAndAwaitId: jest.fn().mockResolvedValue(null),
      deleteMessage: jest.fn(),
      getOnlineUsers: jest.fn().mockResolvedValue([]),
      username: 'Aria',
    };
    usage = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BotService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ChatService, useValue: chat },
        { provide: MusicService, useValue: {} },
        { provide: AniListService, useValue: anilist },
        {
          provide: UtilsService,
          useValue: {
            sleep: jest.fn().mockResolvedValue(undefined),
            splitMessageIntoParts: jest.fn().mockReturnValue([]),
          },
        },
        { provide: LoggingService, useValue: { saveLog: jest.fn().mockResolvedValue(undefined) } },
        { provide: MemoryService, useValue: {} },
        { provide: ChatSocketService, useValue: socket },
        { provide: GraphIngestService, useValue: ingest },
        { provide: GraphCacheService, useValue: cache },
        { provide: UsageService, useValue: usage },
      ],
    }).compile();

    // No se llama a onModuleInit: registraría el handler del socket, que no
    // hace falta para probar el flujo de decisión de handleAniListRequest.
    service = moduleRef.get<BotService>(BotService);
  });

  const invocar = (kind: string, title: string, authorUsername: string) =>
    (service as unknown as BotServiceConCache).handleAniListRequest(kind, title, authorUsername);

  /** El registro de uso y la ingesta al grafo son fire-and-forget. */
  const dejarCorrer = () => new Promise((r) => setImmediate(r));

  describe('handleAniListRequest — caché', () => {
    it('con acierto no consulta AniList ni traduce', async () => {
      cache.findWork.mockResolvedValue({ result: ficha, sinopsisEs: 'Un cazador débil...' });

      await invocar('manhwa', 'Solo Leveling', 'Nico');

      expect(anilist.search).not.toHaveBeenCalled();
      expect(chat.translateToSpanish).not.toHaveBeenCalled();
      expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Solo Leveling'));
    });

    it('con acierto registra cacheHit para poder medir el ahorro', async () => {
      cache.findWork.mockResolvedValue({ result: ficha, sinopsisEs: 'texto' });

      await invocar('manhwa', 'Solo Leveling', 'Nico');
      await dejarCorrer();

      expect(usage.record).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'translate', cacheHit: true, promptTokens: 0 }),
      );
    });

    it('con acierto pero sin traducción guardada, sí traduce', async () => {
      cache.findWork.mockResolvedValue({ result: ficha, sinopsisEs: null });
      chat.translateToSpanish.mockResolvedValue('traducido');

      await invocar('manhwa', 'Solo Leveling', 'Nico');

      expect(anilist.search).not.toHaveBeenCalled();
      expect(chat.translateToSpanish).toHaveBeenCalled();
    });

    it('con fallo va por el camino normal', async () => {
      cache.findWork.mockResolvedValue(null);
      anilist.search.mockResolvedValue(ficha);
      chat.translateToSpanish.mockResolvedValue('traducido');

      await invocar('manhwa', 'Solo Leveling', 'Nico');

      expect(anilist.search).toHaveBeenCalledWith('manhwa', 'Solo Leveling');
      expect(chat.translateToSpanish).toHaveBeenCalled();
    });

    it('un fallo del caché no impide responder: sigue el camino normal, no el de error', async () => {
      cache.findWork.mockRejectedValue(new Error('mongo caído'));
      anilist.search.mockResolvedValue(ficha);
      chat.translateToSpanish.mockResolvedValue('traducido');

      await invocar('manhwa', 'Solo Leveling', 'Nico');

      // No alcanza con "se llamó a sendMessage": el mensaje de error genérico
      // de AniList también llama a sendMessage. Hay que verificar que se
      // siguió el camino normal (se consultó AniList, se tradujo, se mandó
      // la tarjeta) y no el catch externo (que mandaría un error que nunca
      // ocurrió).
      expect(anilist.search).toHaveBeenCalledWith('manhwa', 'Solo Leveling');
      expect(chat.translateToSpanish).toHaveBeenCalled();
      expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Solo Leveling'));
      expect(socket.sendMessage).not.toHaveBeenCalledWith(
        expect.stringContaining('AniList no respondió'),
      );
    });

    it('con acierto TAMBIÉN registra que el usuario preguntó', async () => {
      cache.findWork.mockResolvedValue({ result: ficha, sinopsisEs: 'texto' });

      await invocar('manhwa', 'Solo Leveling', 'Nico');
      await dejarCorrer();

      expect(ingest.ingestAniList).toHaveBeenCalledWith('Nico', ficha, 'Solo Leveling');
    });
  });
});
