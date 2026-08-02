import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BotService } from './bot.service';
import { ChatService } from '../chat/chat.service';
import { MusicService } from '../music/music.service';
import { AniListService, AniListResult } from '../anilist/anilist.service';
import { UtilsService } from '../../common/utils/utils.service';
import { LoggingService } from '../../common/utils/logging.service';
import { MemoryService } from '../../common/utils/memory.service';
import { ChatSocketService, ChatMessage } from '../chat-socket/chat-socket.service';
import { GraphIngestService } from '../graph/graph-ingest.service';
import { GraphCacheService } from '../graph/graph-cache.service';
import { GraphUserService } from '../graph/graph-user.service';
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
        { provide: GraphUserService, useValue: { describe: jest.fn().mockResolvedValue([]) } },
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
      // `findWork` real SIEMPRE reconstruye la ficha con `description: null`
      // (el caché no persiste el inglés crudo, sólo la traducción) — un
      // acierto sin `sinopsisEs` es un "miss parcial" que necesita volver a
      // AniList para conseguir el texto que va a traducir.
      const fichaDeCache: AniListResult = { ...ficha, description: null };
      cache.findWork.mockResolvedValue({ result: fichaDeCache, sinopsisEs: null });
      anilist.search.mockResolvedValue(ficha); // AniList sí trae el inglés
      chat.translateToSpanish.mockResolvedValue('traducido');

      await invocar('manhwa', 'Solo Leveling', 'Nico');

      expect(anilist.search).toHaveBeenCalledWith('manhwa', 'Solo Leveling');
      expect(chat.translateToSpanish).toHaveBeenCalledWith(ficha.description, 'Nico');
    });

    it('con acierto pero sin traducción guardada, la ingesta renueva cachedAt (sí habló con AniList)', async () => {
      const fichaDeCache: AniListResult = { ...ficha, description: null };
      cache.findWork.mockResolvedValue({ result: fichaDeCache, sinopsisEs: null });
      anilist.search.mockResolvedValue(ficha);
      chat.translateToSpanish.mockResolvedValue('traducido');

      await invocar('manhwa', 'Solo Leveling', 'Nico');
      await dejarCorrer();

      expect(ingest.ingestAniList).toHaveBeenCalledWith('Nico', ficha, 'Solo Leveling', { refreshCache: true });
    });

    it('con fallo va por el camino normal', async () => {
      cache.findWork.mockResolvedValue(null);
      anilist.search.mockResolvedValue(ficha);
      chat.translateToSpanish.mockResolvedValue('traducido');

      await invocar('manhwa', 'Solo Leveling', 'Nico');

      expect(anilist.search).toHaveBeenCalledWith('manhwa', 'Solo Leveling');
      expect(chat.translateToSpanish).toHaveBeenCalled();
    });

    it('con miss total, la ingesta renueva cachedAt (habló con AniList)', async () => {
      cache.findWork.mockResolvedValue(null);
      anilist.search.mockResolvedValue(ficha);
      chat.translateToSpanish.mockResolvedValue('traducido');

      await invocar('manhwa', 'Solo Leveling', 'Nico');
      await dejarCorrer();

      expect(ingest.ingestAniList).toHaveBeenCalledWith('Nico', ficha, 'Solo Leveling', { refreshCache: true });
    });

    it('no persiste la traducción cuando translateToSpanish cae a su fallback (texto igual al original)', async () => {
      // El fallback documentado de translateToSpanish es devolver el texto
      // original en inglés cuando el modelo falla o responde vacío. Antes de
      // este fix eso se guardaba como si fuera una traducción buena y, al no
      // vencer nunca una obra FINISHED, quedaba en inglés para siempre.
      cache.findWork.mockResolvedValue(null);
      anilist.search.mockResolvedValue(ficha);
      chat.translateToSpanish.mockResolvedValue(ficha.description);

      await invocar('manhwa', 'Solo Leveling', 'Nico');
      await dejarCorrer();

      expect(cache.saveTranslation).not.toHaveBeenCalled();
    });

    it('sí persiste la traducción cuando es distinta del original', async () => {
      cache.findWork.mockResolvedValue(null);
      anilist.search.mockResolvedValue(ficha);
      chat.translateToSpanish.mockResolvedValue('Un cazador débil recibe una segunda oportunidad.');

      await invocar('manhwa', 'Solo Leveling', 'Nico');
      await dejarCorrer();

      expect(cache.saveTranslation).toHaveBeenCalledWith(
        ficha.id,
        'Un cazador débil recibe una segunda oportunidad.',
      );
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

    it('con acierto TAMBIÉN registra que el usuario preguntó, sin renovar cachedAt', async () => {
      cache.findWork.mockResolvedValue({ result: ficha, sinopsisEs: 'texto' });

      await invocar('manhwa', 'Solo Leveling', 'Nico');
      await dejarCorrer();

      // refreshCache: false — es un acierto completo, no habló con AniList,
      // así que no debe renovar `cachedAt` (fix crítico 1: TTL invertido).
      expect(ingest.ingestAniList).toHaveBeenCalledWith('Nico', ficha, 'Solo Leveling', { refreshCache: false });
    });
  });
});

/**
 * `handleSummaryRequest` es privado — mismo patrón de cast puntual que
 * `handleAniListRequest` arriba.
 */
type BotServiceConResumen = {
  handleSummaryRequest(response: string, authorUsername: string): Promise<void>;
};

describe('BotService — handleSummaryRequest (Task 5, fase 4b — hechos extraídos del resumen)', () => {
  let service: BotService;
  let chat: { generateSummary: jest.Mock };
  let ingest: { ingestFact: jest.Mock };
  let logging: {
    saveLog: jest.Mock;
    getLastEventType: jest.Mock;
    saveEventsLog: jest.Mock;
    clearMessagesLog: jest.Mock;
  };
  let socket: {
    onMessage: jest.Mock;
    sendMessage: jest.Mock;
    sendMessageAndAwaitId: jest.Mock;
    deleteMessage: jest.Mock;
    getOnlineUsers: jest.Mock;
    username: string;
  };
  let utils: { sleep: jest.Mock; splitMessageIntoParts: jest.Mock };

  beforeEach(async () => {
    chat = { generateSummary: jest.fn() };
    ingest = { ingestFact: jest.fn().mockResolvedValue(undefined) };
    logging = {
      saveLog: jest.fn().mockResolvedValue(undefined),
      getLastEventType: jest.fn().mockResolvedValue({ minutesLeft: 1000, lastResumenEvent: null }),
      saveEventsLog: jest.fn().mockResolvedValue(undefined),
      clearMessagesLog: jest.fn().mockResolvedValue(0),
    };
    socket = {
      onMessage: jest.fn(),
      sendMessage: jest.fn(),
      sendMessageAndAwaitId: jest.fn().mockResolvedValue(null),
      deleteMessage: jest.fn(),
      getOnlineUsers: jest.fn().mockResolvedValue([]),
      username: 'Aria',
    };
    // Split identidad: alcanza para estas pruebas, que no ejercitan el
    // troceado en sí (ya cubierto en otras partes del repo).
    utils = {
      sleep: jest.fn().mockResolvedValue(undefined),
      splitMessageIntoParts: jest.fn((text: string) => [text]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BotService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ChatService, useValue: chat },
        { provide: MusicService, useValue: {} },
        { provide: AniListService, useValue: {} },
        { provide: UtilsService, useValue: utils },
        { provide: LoggingService, useValue: logging },
        { provide: MemoryService, useValue: {} },
        { provide: ChatSocketService, useValue: socket },
        { provide: GraphIngestService, useValue: ingest },
        { provide: GraphCacheService, useValue: {} },
        { provide: GraphUserService, useValue: { describe: jest.fn().mockResolvedValue([]) } },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = moduleRef.get<BotService>(BotService);
  });

  const invocar = (response: string, authorUsername: string) =>
    (service as unknown as BotServiceConResumen).handleSummaryRequest(response, authorUsername);

  /** La ingesta de hechos es fire-and-forget: hay que dejar correr la microtask. */
  const dejarCorrer = () => new Promise((r) => setImmediate(r));

  it('tras generar el resumen, ingesta cada hecho extraído con source "batch"', async () => {
    chat.generateSummary.mockResolvedValue({
      text: 'Resumen del chat',
      facts: [
        { user: 'Nico', relation: 'likes', object: 'Attack on Titan' },
        { user: 'Kei', relation: 'dislikes', object: 'el ecchi' },
      ],
    });

    await invocar('{{resumen}}', 'Nico');
    await dejarCorrer();

    // El orden y el cuarto argumento ('batch') distinguen esto de la ingesta
    // en vivo de SAVE_FACT (source: 'fact', sin este cuarto argumento).
    expect(ingest.ingestFact).toHaveBeenCalledTimes(2);
    expect(ingest.ingestFact).toHaveBeenNthCalledWith(1, 'Nico', 'likes', 'Attack on Titan', 'batch');
    expect(ingest.ingestFact).toHaveBeenNthCalledWith(2, 'Kei', 'dislikes', 'el ecchi', 'batch');
  });

  it('un fallo de la ingesta no impide enviar el resumen al chat', async () => {
    chat.generateSummary.mockResolvedValue({
      text: 'Resumen del chat',
      facts: [{ user: 'Nico', relation: 'likes', object: 'Attack on Titan' }],
    });
    ingest.ingestFact.mockRejectedValue(new Error('mongo caído'));

    await invocar('{{resumen}}', 'Nico');
    await dejarCorrer();

    // Si la ingesta se esperara sin su propio catch (en vez de fire-and-forget),
    // el rechazo del mock rompería el try y el catch externo mandaría el
    // mensaje de error genérico en lugar del resumen — esta aserción
    // distingue ambos caminos.
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Resumen del chat'));
    expect(socket.sendMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('Error al generar el resumen'),
    );
  });

  describe('Revisión final (Minor #6) — el resumen fallido no debe quemar el cooldown ni borrar el log', () => {
    it('cuando generateSummary devuelve el mensaje de error de parseo, NO consume el cooldown ni limpia el log', async () => {
      // `generateSummary` no lanza cuando el parseo falla: devuelve
      // normalmente `text` igual a `ChatService.SUMMARY_PARSE_ERROR`, que el
      // bucle de envío ya manda al chat como si fuera un resumen real. Antes
      // de este fix, eso igual quemaba el cooldown de 10 minutos y borraba
      // los 50 mensajes del log — el usuario quedaba sin poder reintentar
      // por un fallo que no fue suyo.
      chat.generateSummary.mockResolvedValue({
        text: ChatService.SUMMARY_PARSE_ERROR,
        facts: [],
      });

      await invocar('{{resumen}}', 'Nico');
      await dejarCorrer();

      expect(socket.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining(ChatService.SUMMARY_PARSE_ERROR),
      );
      expect(logging.saveEventsLog).not.toHaveBeenCalled();
      expect(logging.clearMessagesLog).not.toHaveBeenCalled();
    });

    it('cuando el resumen es válido, sí consume el cooldown y limpia el log (comportamiento normal, sin regresión)', async () => {
      chat.generateSummary.mockResolvedValue({
        text: 'Resumen del chat',
        facts: [],
      });

      await invocar('{{resumen}}', 'Nico');
      await dejarCorrer();

      expect(logging.saveEventsLog).toHaveBeenCalledWith('Resumen', 'Nico');
      expect(logging.clearMessagesLog).toHaveBeenCalled();
    });
  });
});

/**
 * `handleNewChatMessage` es privado — mismo patrón de cast puntual que los
 * dos describes de arriba. A diferencia de esos, acá lo que importa es el
 * dispatcher completo (no un handler puntual), porque la garantía a probar
 * ("no llama al modelo") depende de que el comando corte ANTES de llegar al
 * resto del método.
 */
type BotServiceConDispatcher = {
  handleNewChatMessage(msg: ChatMessage): Promise<void>;
};

describe('BotService — handleMemoryCommand (!quesabes, Task 2 fase 5a)', () => {
  let service: BotService;
  let chat: { chat: jest.Mock };
  let graphUser: { describe: jest.Mock };
  let ingest: { ingestSocial: jest.Mock };
  let logging: { saveLog: jest.Mock };
  let socket: {
    onMessage: jest.Mock;
    sendMessage: jest.Mock;
    sendMessageAndAwaitId: jest.Mock;
    deleteMessage: jest.Mock;
    getOnlineUsers: jest.Mock;
    username: string;
  };
  let utils: { sleep: jest.Mock; splitMessageIntoParts: jest.Mock };

  beforeEach(async () => {
    chat = { chat: jest.fn().mockResolvedValue('esto NO debería enviarse jamás') };
    graphUser = { describe: jest.fn() };
    ingest = { ingestSocial: jest.fn().mockResolvedValue(undefined) };
    logging = { saveLog: jest.fn().mockResolvedValue(undefined) };
    socket = {
      onMessage: jest.fn(),
      sendMessage: jest.fn(),
      sendMessageAndAwaitId: jest.fn().mockResolvedValue(null),
      deleteMessage: jest.fn(),
      getOnlineUsers: jest.fn().mockResolvedValue([]),
      username: 'Aria',
    };
    // Split identidad: estas pruebas no ejercitan el troceado en sí (ya
    // cubierto por los tests de `UtilsService`), sólo que el mensaje armado
    // llegue a `sendMessage`.
    utils = {
      sleep: jest.fn().mockResolvedValue(undefined),
      splitMessageIntoParts: jest.fn((text: string) => [text]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BotService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ChatService, useValue: chat },
        { provide: MusicService, useValue: {} },
        { provide: AniListService, useValue: {} },
        { provide: UtilsService, useValue: utils },
        { provide: LoggingService, useValue: logging },
        { provide: MemoryService, useValue: {} },
        { provide: ChatSocketService, useValue: socket },
        { provide: GraphIngestService, useValue: ingest },
        { provide: GraphCacheService, useValue: {} },
        { provide: GraphUserService, useValue: graphUser },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    // No se llama a onModuleInit: registraría el handler real del socket,
    // que no hace falta para invocar `handleNewChatMessage` directamente.
    service = moduleRef.get<BotService>(BotService);
  });

  const mensaje = (content: string, authorUsername: string): ChatMessage => ({
    _id: '1',
    content,
    authorUsername,
    authorRole: 'user',
    type: 'text',
    createdAt: new Date().toISOString(),
  });

  const invocar = (content: string, authorUsername: string) =>
    (service as unknown as BotServiceConDispatcher).handleNewChatMessage(mensaje(content, authorUsername));

  /** La ingesta al grafo (ingestSocial) es fire-and-forget. */
  const dejarCorrer = () => new Promise((r) => setImmediate(r));

  it('"!quesabes" responde con la lista y NO llama al modelo', async () => {
    graphUser.describe.mockResolvedValue([
      { relation: 'likes', label: 'Berserk', weight: 3 },
      { relation: 'asked_about', label: 'Solo Leveling', weight: 1 },
    ]);

    await invocar('!quesabes', 'Nico');
    await dejarCorrer();

    expect(graphUser.describe).toHaveBeenCalledWith('Nico');
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Berserk'));
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Solo Leveling'));
    // No sólo "se mandó un mensaje": el mensaje agrupa por relación con una
    // etiqueta legible, no el EdgeType crudo.
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Te gusta'));
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Preguntaste por'));
    expect(socket.sendMessage).not.toHaveBeenCalledWith(expect.stringContaining('asked_about'));
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('"!quesabes" de alguien sin datos responde un mensaje claro, y tampoco llama al modelo', async () => {
    graphUser.describe.mockResolvedValue([]);

    await invocar('!quesabes', 'Nico');
    await dejarCorrer();

    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('nada guardado'));
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('el comando corta el dispatcher: no se procesa como mensaje normal', async () => {
    // El mensaje incluye la palabra "bot": si el dispatcher NO cortara acá,
    // seguiría de largo hasta el filtro de menciones (que "bot" sí supera) y
    // terminaría llamando a `chatService.chat`. Que el modelo nunca se llame
    // es la única forma de distinguir "cortó en el comando" de "no había
    // nada más que hacer" — con un mensaje que no dijera "bot" ambos caminos
    // se verían idénticos desde afuera.
    graphUser.describe.mockResolvedValue([{ relation: 'likes', label: 'Berserk', weight: 1 }]);

    await invocar('!quesabes bot', 'Nico');
    await dejarCorrer();

    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('"!quesabes" con argumentos extra sigue describiendo al que lo escribió, no a otro', async () => {
    graphUser.describe.mockResolvedValue([{ relation: 'likes', label: 'Berserk', weight: 1 }]);

    await invocar('!quesabes OtraPersona', 'Nico');
    await dejarCorrer();

    // Privacidad: cualquier argumento después del comando se ignora. Nadie
    // puede consultar lo que el bot guarda sobre otra persona — el comando
    // SIEMPRE describe a quien lo escribió (authorUsername), nunca al texto
    // que sigue.
    expect(graphUser.describe).toHaveBeenCalledWith('Nico');
    expect(graphUser.describe).not.toHaveBeenCalledWith('OtraPersona');
    expect(chat.chat).not.toHaveBeenCalled();
  });
});
