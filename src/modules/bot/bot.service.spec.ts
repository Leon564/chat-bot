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
import { GraphService, Candidate } from '../graph/graph.service';
import { GraphUserService, MAX_FACTS_SHOWN } from '../graph/graph-user.service';
import { UsageService } from '../chat/usage.service';
import { RateLimitService } from './rate-limit.service';

/**
 * Stub de `GraphService` para los describes que no ejercitan la
 * recomendación colaborativa (Task 3, fase 5b): `findNode` resuelve `null`,
 * así que `markCollaborativeRecommendations` corta apenas empieza y el resto
 * de esos tests queda exactamente igual que antes de agregar la dependencia.
 */
const noopGraphService = {
  findNode: jest.fn().mockResolvedValue(null),
  collaborative: jest.fn().mockResolvedValue([]),
  normalizeKey: jest.fn((s: string) => (s ?? '').toString().toLowerCase()),
  upsertEdge: jest.fn().mockResolvedValue(undefined),
};

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
        { provide: GraphService, useValue: noopGraphService },
        { provide: GraphUserService, useValue: { describe: jest.fn().mockResolvedValue([]) } },
        { provide: UsageService, useValue: usage },
        { provide: RateLimitService, useValue: { check: jest.fn().mockReturnValue(true) } },
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
        { provide: GraphService, useValue: noopGraphService },
        { provide: GraphUserService, useValue: { describe: jest.fn().mockResolvedValue([]) } },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: RateLimitService, useValue: { check: jest.fn().mockReturnValue(true) } },
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
        { provide: GraphService, useValue: noopGraphService },
        { provide: GraphUserService, useValue: graphUser },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: RateLimitService, useValue: { check: jest.fn().mockReturnValue(true) } },
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

  it('Minor #5 — un EdgeType fuera de RELATION_ORDER igual se muestra, no desaparece', async () => {
    // 'has_genre' SÍ está en RELATION_ORDER; usamos un valor que no calzaría
    // con ninguna entrada para simular un EdgeType agregado después que nadie
    // sincronizó en el array. El contrato de `!quesabes` es "TODO lo que
    // tengo guardado" — el default tiene que ser mostrar de más, no ocultar.
    graphUser.describe.mockResolvedValue([
      { relation: 'likes', label: 'Berserk', weight: 3 },
      { relation: 'nuevo_tipo_no_listado' as never, label: 'Cosa Rara', weight: 1 },
    ]);

    await invocar('!quesabes', 'Nico');
    await dejarCorrer();

    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Cosa Rara'));
  });

  it('Minor #6 — con la lista truncada al tope, avisa que sólo muestra las más fuertes', async () => {
    const facts = Array.from({ length: MAX_FACTS_SHOWN }, (_, i) => ({
      relation: 'likes' as const,
      label: `Obra ${i}`,
      weight: MAX_FACTS_SHOWN - i,
    }));
    graphUser.describe.mockResolvedValue(facts);

    await invocar('!quesabes', 'Nico');
    await dejarCorrer();

    expect(socket.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining(`${MAX_FACTS_SHOWN} más fuertes`),
    );
  });

  it('con menos hechos que el tope, NO avisa de truncamiento', async () => {
    graphUser.describe.mockResolvedValue([{ relation: 'likes', label: 'Berserk', weight: 1 }]);

    await invocar('!quesabes', 'Nico');
    await dejarCorrer();

    expect(socket.sendMessage).not.toHaveBeenCalledWith(expect.stringContaining('más fuertes'));
  });

  it('Minor #7 — con varias partes, respeta responseDelay entre mensajes (igual que las otras rutas multiparte)', async () => {
    utils.splitMessageIntoParts.mockReturnValue(['parte 1', 'parte 2', 'parte 3']);
    graphUser.describe.mockResolvedValue([{ relation: 'likes', label: 'Berserk', weight: 1 }]);

    await invocar('!quesabes', 'Nico');
    await dejarCorrer();

    expect(socket.sendMessage).toHaveBeenCalledTimes(3);
    // Un sleep entre cada par de partes: 2 sleeps para 3 partes, no antes de
    // la primera ni después de la última.
    expect(utils.sleep).toHaveBeenCalledTimes(2);
  });
});

describe('BotService — handleForgetCommand (!olvida, Task 3 fase 5a)', () => {
  let service: BotService;
  let chat: { chat: jest.Mock };
  let graphUser: {
    describe: jest.Mock;
    findForgettable: jest.Mock;
    forget: jest.Mock;
    forgetAll: jest.Mock;
    countForgettableAll: jest.Mock;
  };
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
    graphUser = {
      describe: jest.fn().mockResolvedValue([]),
      findForgettable: jest.fn(),
      forget: jest.fn(),
      forgetAll: jest.fn(),
      countForgettableAll: jest.fn(),
    };
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
        { provide: GraphService, useValue: noopGraphService },
        { provide: GraphUserService, useValue: graphUser },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: RateLimitService, useValue: { check: jest.fn().mockReturnValue(true) } },
      ],
    }).compile();

    // No se llama a onModuleInit, mismo motivo que en los describes de arriba.
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

  it('"!olvida berserk" borra y confirma cuántas cosas borró', async () => {
    graphUser.findForgettable.mockResolvedValue([{ relation: 'likes', label: 'Berserk', weight: 3 }]);
    graphUser.forget.mockResolvedValue(1);

    await invocar('!olvida berserk', 'Nico');
    await dejarCorrer();

    expect(graphUser.findForgettable).toHaveBeenCalledWith('Nico', 'berserk');
    expect(graphUser.forget).toHaveBeenCalledWith('Nico', 'berserk');
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Berserk'));
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringMatching(/borr[eé] 1/i));
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('"!olvida" sin término responde el uso, sin borrar', async () => {
    await invocar('!olvida', 'Nico');
    await dejarCorrer();

    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Uso:'));
    expect(graphUser.findForgettable).not.toHaveBeenCalled();
    expect(graphUser.forget).not.toHaveBeenCalled();
    expect(graphUser.forgetAll).not.toHaveBeenCalled();
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('"!olvida algo que no existe" responde que no encontró nada, sin borrar', async () => {
    graphUser.findForgettable.mockResolvedValue([]);

    await invocar('!olvida algoqueNoExiste', 'Nico');
    await dejarCorrer();

    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('No encontré'));
    // El camino de "no encontré nada" nunca debe llamar a forget: si
    // findForgettable no matcheó nada, no hay nada que ejecutar.
    expect(graphUser.forget).not.toHaveBeenCalled();
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('un término de menos de 3 caracteres se rechaza sin consultar el grafo', async () => {
    await invocar('!olvida ab', 'Nico');
    await dejarCorrer();

    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('corto'));
    expect(graphUser.findForgettable).not.toHaveBeenCalled();
    expect(graphUser.forget).not.toHaveBeenCalled();
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('"!olvida todo" NO borra: pide confirmación, y las aristas siguen existiendo', async () => {
    graphUser.countForgettableAll.mockResolvedValue(5);

    await invocar('!olvida todo', 'Nico');
    await dejarCorrer();

    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('5'));
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('!olvida todo si'));
    // Esta es la aserción que importa de verdad: un test que sólo mirara el
    // mensaje de confirmación pasaría igual si el comando además hubiera
    // borrado. `forgetAll` es el único camino que borra algo en este
    // servicio — que nunca se haya llamado es la prueba de que las aristas
    // siguen existiendo, no sólo que se pidió confirmación.
    expect(graphUser.forgetAll).not.toHaveBeenCalled();
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('"!olvida todo si" sí borra', async () => {
    graphUser.forgetAll.mockResolvedValue(5);

    await invocar('!olvida todo si', 'Nico');
    await dejarCorrer();

    expect(graphUser.forgetAll).toHaveBeenCalledWith('Nico');
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringMatching(/borr[eé] 5/i));
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('Minor #4 — "!olvida todo sí" (con tilde) también confirma, no cae al buscador de términos', async () => {
    graphUser.forgetAll.mockResolvedValue(5);

    await invocar('!olvida todo sí', 'Nico');
    await dejarCorrer();

    expect(graphUser.forgetAll).toHaveBeenCalledWith('Nico');
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringMatching(/borr[eé] 5/i));
    // El modo de falla viejo era caer acá y responder "no encontré nada" en
    // vez de confirmar — verificamos que ese camino ya no se toma.
    expect(graphUser.findForgettable).not.toHaveBeenCalled();
  });

  it('el comando corta el dispatcher: no se procesa como mensaje normal', async () => {
    // Mismo razonamiento que el test equivalente de !quesabes: "olvida"
    // no contiene la palabra "bot", así que agregamos el nombre del bot al
    // mensaje para que, si el dispatcher NO cortara acá, siguiera de largo
    // hasta el filtro de menciones y terminara llamando a chatService.chat.
    graphUser.findForgettable.mockResolvedValue([{ relation: 'likes', label: 'Berserk', weight: 1 }]);
    graphUser.forget.mockResolvedValue(1);

    await invocar('!olvida berserk Aria', 'Nico');
    await dejarCorrer();

    expect(chat.chat).not.toHaveBeenCalled();
  });
});

describe('BotService — guard de límite de gasto (Task 4, fase 5a)', () => {
  let service: BotService;
  let chat: { chat: jest.Mock };
  let rateLimit: { check: jest.Mock; shouldNotifyRejection: jest.Mock };
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
    chat = { chat: jest.fn().mockResolvedValue('respuesta del modelo') };
    // `shouldNotifyRejection` por defecto `true`: estos tests verifican el
    // guard en sí (check), no el cooldown del aviso — ese vive en su propio
    // describe más abajo.
    rateLimit = { check: jest.fn(), shouldNotifyRejection: jest.fn().mockReturnValue(true) };
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
        { provide: GraphService, useValue: noopGraphService },
        { provide: GraphUserService, useValue: { describe: jest.fn().mockResolvedValue([]) } },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: RateLimitService, useValue: rateLimit },
      ],
    }).compile();

    // No se llama a onModuleInit, mismo motivo que en los otros describes.
    service = moduleRef.get<BotService>(BotService);
  });

  const mensaje = (content: string, authorUsername: string, authorRole?: string): ChatMessage => ({
    _id: '1',
    content,
    authorUsername,
    authorRole,
    type: 'text',
    createdAt: new Date().toISOString(),
  });

  const invocar = (content: string, authorUsername: string, authorRole?: string) =>
    (service as unknown as BotServiceConDispatcher).handleNewChatMessage(
      mensaje(content, authorUsername, authorRole),
    );

  /** La ingesta al grafo (ingestSocial) es fire-and-forget. */
  const dejarCorrer = () => new Promise((r) => setImmediate(r));

  it('superado el tope, se responde un mensaje fijo y NO se llama al modelo', async () => {
    rateLimit.check.mockReturnValue(false);

    await invocar('bot decime algo', 'Nico', 'user');
    await dejarCorrer();

    // La aserción que importa: el modelo NO se llamó. No alcanza con "se
    // mandó algún mensaje" — eso también sería cierto si el guard fallara y
    // el mensaje enviado fuera la respuesta real del modelo.
    expect(chat.chat).not.toHaveBeenCalled();
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Nico'));
    expect(socket.sendMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('respuesta del modelo'),
    );
    expect(rateLimit.check).toHaveBeenCalledWith('Nico', 'user');
    expect(rateLimit.shouldNotifyRejection).toHaveBeenCalledWith('Nico');
  });

  it('Important #2 — pasado el cooldown de aviso, NO se manda el mensaje de rate-limit (silencio, no flood)', async () => {
    // `shouldNotifyRejection` en `false` simula que ya se avisó recientemente
    // dentro de la ventana de cooldown: BotService no debe insistir con el
    // aviso en cada mensaje rechazado — eso abriría un canal de flood
    // gratuito, justo lo que este guard evita.
    rateLimit.check.mockReturnValue(false);
    rateLimit.shouldNotifyRejection.mockReturnValue(false);

    await invocar('bot decime algo', 'Nico', 'user');
    await dejarCorrer();

    expect(chat.chat).not.toHaveBeenCalled();
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it('superado el tope, un admin sí llega al modelo', async () => {
    // El propio RateLimitService ya exime a admin/superAdmin, pero el mock
    // de este describe no reimplementa esa lógica — lo que se prueba acá es
    // que BotService le pasa el rol al guard y respeta lo que responda.
    rateLimit.check.mockReturnValue(true);

    await invocar('bot decime algo', 'Nico', 'admin');
    await dejarCorrer();

    expect(rateLimit.check).toHaveBeenCalledWith('Nico', 'admin');
    expect(chat.chat).toHaveBeenCalled();
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('respuesta del modelo'));
  });

  it('por debajo del tope, todo funciona igual que antes', async () => {
    rateLimit.check.mockReturnValue(true);

    await invocar('bot decime algo', 'Nico', 'user');
    await dejarCorrer();

    expect(chat.chat).toHaveBeenCalledWith('bot decime algo', 'Aria', 'Nico');
    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('respuesta del modelo'));
  });
});

describe('BotService — marcado de recomendación colaborativa (Task 3, fase 5b)', () => {
  let service: BotService;
  let chat: { chat: jest.Mock };
  let graph: {
    findNode: jest.Mock;
    collaborative: jest.Mock;
    normalizeKey: jest.Mock;
    upsertEdge: jest.Mock;
  };
  let socket: {
    onMessage: jest.Mock;
    sendMessage: jest.Mock;
    sendMessageAndAwaitId: jest.Mock;
    deleteMessage: jest.Mock;
    getOnlineUsers: jest.Mock;
    username: string;
  };

  /** Misma normalización que `GraphService.normalizeKey` (minúsculas, sin acentos, espacios colapsados). */
  const normalize = (s: string) =>
    (s ?? '')
      .toString()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');

  const CANDIDATOS: Candidate[] = [
    { key: 'vinland-saga', label: 'Vinland Saga', score: 5 },
    { key: 'berserk', label: 'Berserk', score: 3 },
  ];

  beforeEach(async () => {
    chat = { chat: jest.fn().mockResolvedValue('respuesta del modelo') };
    graph = {
      // Resuelve el nodo `user` de quien escribió, y el nodo `work` de cada
      // candidata por su `key` — el mismo par de llamadas que hace
      // `markCollaborativeRecommendations`.
      findNode: jest.fn((type: string, key: string) => {
        if (type === 'user' && key === 'Nico') return Promise.resolve({ _id: 'nico-id' });
        if (type === 'work' && key === 'vinland-saga') return Promise.resolve({ _id: 'vinland-id' });
        if (type === 'work' && key === 'berserk') return Promise.resolve({ _id: 'berserk-id' });
        if (type === 'work' && key === 'air') return Promise.resolve({ _id: 'air-id' });
        if (type === 'work' && key === 'fate') return Promise.resolve({ _id: 'fate-id' });
        if (type === 'work' && key === 'fate-zero') return Promise.resolve({ _id: 'fate-zero-id' });
        return Promise.resolve(null);
      }),
      collaborative: jest.fn().mockResolvedValue(CANDIDATOS),
      normalizeKey: jest.fn(normalize),
      upsertEdge: jest.fn().mockResolvedValue(undefined),
    };
    socket = {
      onMessage: jest.fn(),
      sendMessage: jest.fn(),
      sendMessageAndAwaitId: jest.fn().mockResolvedValue(null),
      deleteMessage: jest.fn(),
      getOnlineUsers: jest.fn().mockResolvedValue([]),
      username: 'Aria',
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BotService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ChatService, useValue: chat },
        { provide: MusicService, useValue: {} },
        { provide: AniListService, useValue: {} },
        {
          provide: UtilsService,
          useValue: {
            sleep: jest.fn().mockResolvedValue(undefined),
            splitMessageIntoParts: jest.fn((text: string) => [text]),
          },
        },
        { provide: LoggingService, useValue: { saveLog: jest.fn().mockResolvedValue(undefined) } },
        { provide: MemoryService, useValue: {} },
        { provide: ChatSocketService, useValue: socket },
        { provide: GraphIngestService, useValue: { ingestSocial: jest.fn().mockResolvedValue(undefined) } },
        { provide: GraphCacheService, useValue: {} },
        { provide: GraphService, useValue: graph },
        { provide: GraphUserService, useValue: { describe: jest.fn().mockResolvedValue([]) } },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: RateLimitService,
          useValue: { check: jest.fn().mockReturnValue(true), shouldNotifyRejection: jest.fn().mockReturnValue(true) },
        },
      ],
    }).compile();

    // No se llama a onModuleInit, mismo motivo que en los describes de arriba.
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

  /** El marcado es fire-and-forget, después de enviar la respuesta: hay que dejar correr la microtask. */
  const dejarCorrer = () => new Promise((r) => setImmediate(r));

  it('tras responder, marca como recommended_to SÓLO la candidata que aparece en la respuesta', async () => {
    chat.chat.mockResolvedValue('Deberías probar Vinland Saga, seguro te gusta.');

    await invocar('bot recomendame algo', 'Nico');
    await dejarCorrer();

    expect(graph.upsertEdge).toHaveBeenCalledTimes(1);
    expect(graph.upsertEdge).toHaveBeenCalledWith({
      from: 'nico-id',
      to: 'vinland-id',
      type: 'recommended_to',
      source: 'signal',
    });
    // Berserk estaba entre las candidatas que devolvió collaborative, pero el
    // modelo no la mencionó: no se marca. Marcar de más significaría no
    // volver a ofrecerla más adelante, aunque nunca se haya sugerido de verdad.
    expect(graph.upsertEdge).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: 'berserk-id' }),
    );
  });

  it('una candidata que el modelo no mencionó NO se marca', async () => {
    // Ninguna de las dos etiquetas aparece en el texto.
    chat.chat.mockResolvedValue('Qué buena pregunta, no tengo nada puntual para recomendarte hoy.');

    await invocar('bot recomendame algo', 'Nico');
    await dejarCorrer();

    // Si el marcado ignorara el filtro por mención (marcara toda candidata
    // que devuelve collaborative, se haya dicho o no), esta aserción fallaría.
    expect(graph.upsertEdge).not.toHaveBeenCalled();
  });

  it('si el modelo menciona las dos candidatas, se marcan las dos', async () => {
    chat.chat.mockResolvedValue('Te recomiendo Vinland Saga y también Berserk, ambas te van a encantar.');

    await invocar('bot recomendame algo', 'Nico');
    await dejarCorrer();

    expect(graph.upsertEdge).toHaveBeenCalledTimes(2);
    expect(graph.upsertEdge).toHaveBeenCalledWith(expect.objectContaining({ to: 'vinland-id' }));
    expect(graph.upsertEdge).toHaveBeenCalledWith(expect.objectContaining({ to: 'berserk-id' }));
  });

  it('sin candidatas de collaborative, no marca nada', async () => {
    graph.collaborative.mockResolvedValue([]);
    chat.chat.mockResolvedValue('Vinland Saga es genial.');

    await invocar('bot recomendame algo', 'Nico');
    await dejarCorrer();

    expect(graph.upsertEdge).not.toHaveBeenCalled();
  });

  it('un fallo del grafo al marcar no afecta la respuesta ya enviada (fire-and-forget con catch propio)', async () => {
    graph.collaborative.mockRejectedValue(new Error('mongo caído'));
    chat.chat.mockResolvedValue('Vinland Saga es genial.');

    await invocar('bot recomendame algo', 'Nico');
    await dejarCorrer();

    expect(socket.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Vinland Saga'));
  });

  describe('límite de palabra en el marcado (ronda de corrección 1)', () => {
    it('"Air" NO se marca cuando el texto sólo dice "aire" — includes() sin límite de palabra marcaría de más', async () => {
      graph.collaborative.mockResolvedValue([{ key: 'air', label: 'Air', score: 4 }]);
      chat.chat.mockResolvedValue('Che, hoy hace un aire fresco buenísimo para salir a caminar.');

      await invocar('bot recomendame algo', 'Nico');
      await dejarCorrer();

      // "air" es prefijo de "aire": sin exigir un límite de palabra real,
      // esta aserción fallaría porque la candidata se marcaría igual.
      expect(graph.upsertEdge).not.toHaveBeenCalled();
    });

    it('"Fate" NO se marca cuando sólo se mencionó "Fate/Zero" (candidata contenida en otra)', async () => {
      graph.collaborative.mockResolvedValue([
        { key: 'fate', label: 'Fate', score: 3 },
        { key: 'fate-zero', label: 'Fate/Zero', score: 5 },
      ]);
      chat.chat.mockResolvedValue('Deberías ver Fate/Zero, es un clásico.');

      await invocar('bot recomendame algo', 'Nico');
      await dejarCorrer();

      expect(graph.upsertEdge).toHaveBeenCalledTimes(1);
      expect(graph.upsertEdge).toHaveBeenCalledWith(expect.objectContaining({ to: 'fate-zero-id' }));
      // "Fate" es subcadena de "Fate/Zero" -- un límite de palabra tipo `\b`
      // igual matchearía "fate" ahí adentro, porque "/" también cuenta como
      // límite de palabra. Sin consumir el texto que ya matcheó la
      // candidata más larga, esta aserción fallaría.
      expect(graph.upsertEdge).not.toHaveBeenCalledWith(expect.objectContaining({ to: 'fate-id' }));
    });

    it('si "Fate" aparece POR SEPARADO de "Fate/Zero" en el mismo texto, también se marca', async () => {
      graph.collaborative.mockResolvedValue([
        { key: 'fate', label: 'Fate', score: 3 },
        { key: 'fate-zero', label: 'Fate/Zero', score: 5 },
      ]);
      chat.chat.mockResolvedValue('Te recomiendo Fate/Zero, y si te gusta, después mirá Fate a secas.');

      await invocar('bot recomendame algo', 'Nico');
      await dejarCorrer();

      // Acá "Fate" SÍ aparece mencionada por su cuenta, en otro lugar del
      // texto -- consumir SIEMPRE toda ocurrencia de la palabra corta (en
      // vez de sólo la porción atribuida a la candidata larga) marcaría de
      // menos y esta aserción fallaría.
      expect(graph.upsertEdge).toHaveBeenCalledTimes(2);
      expect(graph.upsertEdge).toHaveBeenCalledWith(expect.objectContaining({ to: 'fate-zero-id' }));
      expect(graph.upsertEdge).toHaveBeenCalledWith(expect.objectContaining({ to: 'fate-id' }));
    });
  });
});
