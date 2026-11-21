import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BotOutputService } from './bot-output.service';
import { BotCommandsService } from './bot-commands.service';
import { BotService, formatRemaining } from './bot.service';
import { ProactiveService } from './proactive.service';
import { ChatService } from '../chat/chat.service';
import { MusicService } from '../music/music.service';
import { AniListService, AniListResult } from '../anilist/anilist.service';
import { UtilsService } from '../../common/utils/utils.service';
import { LoggingService } from '../../common/utils/logging.service';
import { ChatSocketService, ChatMessage } from '../chat-socket/chat-socket.service';
import { GraphIngestService } from '../graph/graph-ingest.service';
import { GraphCacheService } from '../graph/graph-cache.service';
import { GraphService, Candidate } from '../graph/graph.service';
import { GraphUserService, MAX_FACTS_SHOWN } from '../graph/graph-user.service';
import { UsageService } from '../chat/usage.service';
import { RateLimitService } from './rate-limit.service';
import { CrossContextSettingsService } from '../../common/settings/cross-context-settings.service';
import { ErrandService } from '../graph/errand.service';

import { StickerCatalogService } from '../chat-socket/sticker-catalog.service';
import { StickerGateService } from './sticker-gate.service';
import { RoomInstructionsService } from '../chat/room-instructions.service';

// Presupuesto del corte: `maxLengthResponse` (default 2000, sin config en
// estos tests) menos la mención `<@lyna> ` que antepone handleChatResponse
// — un mensaje del bot que pase el tope del servidor se descarta entero.
const LYNA_SPLIT_BUDGET = 2000 - '<@lyna> '.length;

// Catálogo vacío: con size 0 BotService nunca ofrece stickers, así que los
// tests existentes ven exactamente el flujo de antes.
const emptyStickerCatalog = {
  size: 0,
  describeContent: (c: string) => c,
  promptList: () => '',
  findByName: () => null,
  nameForCode: () => null,
};
const noStickerGate = { decide: () => 'none', markSent: () => {} };

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
 * Doble por defecto de `CrossContextSettingsService` para los describes de
 * este archivo que no ejercitan el contexto cruzado (todos salvo el propio
 * describe de `!contextocruzado`, al final): apagado y sin comportamiento,
 * sólo para satisfacer la inyección del constructor de `BotService`.
 */
const noopCrossContextSettings = {
  isEnabled: jest.fn().mockReturnValue(false),
  setOverride: jest.fn(),
  getInfo: jest.fn().mockReturnValue({ enabled: false, source: 'env' }),
};

/**
 * Doble mínimo de `ErrandService` (Task 5) para los describes de este archivo
 * que resuelven `BotService` directamente vía `Test.createTestingModule` sin
 * pasar por `buildBotService` — sólo satisface la inyección del constructor,
 * ninguno de esos describes ejercita la entrega de recados.
 */
const noopErrandService = {
  claimNext: jest.fn().mockResolvedValue(null),
  // `BotService` le informa su propio nombre en cada mensaje (revisión final
  // de rama, deuda #3): sin este miembro, el doble explota con "not a
  // function" en los describes que despachan un mensaje.
  setBotName: jest.fn(),
};

/**
 * `handleAniListRequest` es privado — se accede con un cast puntual, como se
 * hace con otros métodos privados en specs del repo.
 */
type BotServiceConCache = {
  handleAniListRequest(kind: string, title: string, authorUsername: string): Promise<boolean>;
  handleChatResponse(response: string, authorUsername: string): Promise<void>;
};

describe('BotService — handleAniListRequest (caché)', () => {
  let service: BotService;
  let anilist: { search: jest.Mock };
  let chat: { translateToSpanish: jest.Mock };
  let cache: { findWork: jest.Mock; saveTranslation: jest.Mock };
  let ingest: { ingestAniList: jest.Mock; ingestSocial: jest.Mock; ingestTrack: jest.Mock };
  let socket: {
    onMessage: jest.Mock;
    getReplyContext: jest.Mock;
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
      getReplyContext: jest.fn().mockReturnValue(null),
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
        BotOutputService,
        BotCommandsService,
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
        { provide: ChatSocketService, useValue: socket },
        { provide: GraphIngestService, useValue: ingest },
        { provide: GraphCacheService, useValue: cache },
        { provide: GraphService, useValue: noopGraphService },
        { provide: GraphUserService, useValue: { describe: jest.fn().mockResolvedValue([]) } },
        { provide: UsageService, useValue: usage },
        { provide: RateLimitService, useValue: { check: jest.fn().mockReturnValue(true) } },
        { provide: CrossContextSettingsService, useValue: noopCrossContextSettings },
        { provide: ErrandService, useValue: noopErrandService },
        { provide: StickerCatalogService, useValue: emptyStickerCatalog },
        { provide: StickerGateService, useValue: noStickerGate },
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

  describe('handleAniListRequest — sinopsis completa', () => {
    const enviados = () => socket.sendMessage.mock.calls.map((c) => c[0] as string);

    it('no recorta la sinopsis', async () => {
      const larga = 'Palabra '.repeat(100).trim(); // ~800 caracteres, antes se cortaba a 320
      cache.findWork.mockResolvedValue({ result: ficha, sinopsisEs: larga });

      await invocar('manhwa', 'Solo Leveling', 'Nico');

      expect(enviados()).toHaveLength(1);
      expect(enviados()[0]).toContain(larga);
      expect(enviados()[0]).not.toContain('…');
    });

    it('una sinopsis que no entra en un mensaje se parte sin perder texto ni pasar el tope', async () => {
      const larga = Array.from({ length: 600 }, (_, i) => `w${i}`).join(' '); // ~2800 caracteres
      cache.findWork.mockResolvedValue({ result: ficha, sinopsisEs: larga });

      await invocar('manhwa', 'Solo Leveling', 'Nico');

      const msgs = enviados();
      expect(msgs.length).toBeGreaterThan(1);
      for (const m of msgs) expect(m.length).toBeLessThanOrEqual(1800);
      expect(msgs[0]).toContain('**Solo Leveling**');
      expect(msgs[msgs.length - 1]).toContain(ficha.url);
      const palabras = msgs.join(' ').split(/\s+/).filter((w) => /^w\d+$/.test(w));
      expect(palabras).toEqual(larga.split(' '));
    });
  });

  describe('handleChatResponse — confirmación de AniList', () => {
    it('sin resultado en AniList no manda la frase del modelo, sólo el aviso', async () => {
      cache.findWork.mockResolvedValue(null);
      anilist.search.mockResolvedValue(null);

      await (service as unknown as BotServiceConCache).handleChatResponse(
        '¡Es un clásico! 📖 {{anilist:manga:Obra Inexistente}}',
        'Nico',
      );

      const msgs = socket.sendMessage.mock.calls.map((c) => c[0] as string);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain('No encontré "Obra Inexistente"');
      expect(msgs.join('\n')).not.toContain('clásico');
    });

    it('con resultado manda la confirmación y después la tarjeta', async () => {
      cache.findWork.mockResolvedValue({ result: ficha, sinopsisEs: 'texto' });

      await (service as unknown as BotServiceConCache).handleChatResponse(
        '¡Buena! ⚔️ {{anilist:manhwa:Solo Leveling}}',
        'Nico',
      );

      const msgs = socket.sendMessage.mock.calls.map((c) => c[0] as string);
      expect(msgs[0]).toContain('¡Buena!');
      expect(msgs[1]).toContain('**Solo Leveling**');
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
    getReplyContext: jest.Mock;
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
      getReplyContext: jest.fn().mockReturnValue(null),
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
        BotOutputService,
        BotCommandsService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ChatService, useValue: chat },
        { provide: MusicService, useValue: {} },
        { provide: AniListService, useValue: {} },
        { provide: UtilsService, useValue: utils },
        { provide: LoggingService, useValue: logging },
        { provide: ChatSocketService, useValue: socket },
        { provide: GraphIngestService, useValue: ingest },
        { provide: GraphCacheService, useValue: {} },
        { provide: GraphService, useValue: noopGraphService },
        { provide: GraphUserService, useValue: { describe: jest.fn().mockResolvedValue([]) } },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: RateLimitService, useValue: { check: jest.fn().mockReturnValue(true) } },
        { provide: CrossContextSettingsService, useValue: noopCrossContextSettings },
        { provide: ErrandService, useValue: noopErrandService },
        { provide: StickerCatalogService, useValue: emptyStickerCatalog },
        { provide: StickerGateService, useValue: noStickerGate },
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

  it('el resumen sale como lo contó el modelo, sin encabezado ni cierre fijos', async () => {
    chat.generateSummary.mockResolvedValue({ text: 'Hoy kei no paró de hablar de Frieren y lyna lloró.', facts: [] });

    await invocar('{{resumen}}', 'Nico');
    await dejarCorrer();

    const enviados = socket.sendMessage.mock.calls.map((c) => String(c[0])).join(' ');
    expect(enviados).toContain('📋 Hoy kei no paró de hablar de Frieren');
    expect(enviados).not.toContain('RESUMEN DEL CHAT');
    expect(enviados).not.toContain('Eso es todo por ahora');
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

    it('cuando el resumen es válido, consume el cooldown pero ya NO vacía el log (el evento marca hasta dónde se resumió)', async () => {
      chat.generateSummary.mockResolvedValue({
        text: 'Resumen del chat',
        facts: [],
      });

      await invocar('{{resumen}}', 'Nico');
      await dejarCorrer();

      expect(logging.saveEventsLog).toHaveBeenCalledWith('Resumen', 'Nico');
      expect(logging.clearMessagesLog).not.toHaveBeenCalled();
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
  let chat: { chat: jest.Mock; describeMemory: jest.Mock };
  let graphUser: { describe: jest.Mock };
  let ingest: { ingestSocial: jest.Mock };
  let logging: { saveLog: jest.Mock };
  let socket: {
    onMessage: jest.Mock;
    getReplyContext: jest.Mock;
    sendMessage: jest.Mock;
    sendMessageAndAwaitId: jest.Mock;
    deleteMessage: jest.Mock;
    getOnlineUsers: jest.Mock;
    username: string;
  };
  let utils: { sleep: jest.Mock; splitMessageIntoParts: jest.Mock };

  beforeEach(async () => {
    // describeMemory vacío = el modelo no redactó nada → lista fija (lo que
    // fijan los tests de abajo). Los de la versión natural lo pisan.
    chat = {
      chat: jest.fn().mockResolvedValue('esto NO debería enviarse jamás'),
      describeMemory: jest.fn().mockResolvedValue(''),
    };
    graphUser = { describe: jest.fn() };
    ingest = { ingestSocial: jest.fn().mockResolvedValue(undefined) };
    logging = { saveLog: jest.fn().mockResolvedValue(undefined) };
    socket = {
      onMessage: jest.fn(),
      getReplyContext: jest.fn().mockReturnValue(null),
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
        BotOutputService,
        BotCommandsService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ChatService, useValue: chat },
        { provide: MusicService, useValue: {} },
        { provide: AniListService, useValue: {} },
        { provide: UtilsService, useValue: utils },
        { provide: LoggingService, useValue: logging },
        { provide: ChatSocketService, useValue: socket },
        { provide: GraphIngestService, useValue: ingest },
        { provide: GraphCacheService, useValue: {} },
        { provide: GraphService, useValue: noopGraphService },
        { provide: GraphUserService, useValue: graphUser },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: RateLimitService, useValue: { check: jest.fn().mockReturnValue(true) } },
        { provide: CrossContextSettingsService, useValue: noopCrossContextSettings },
        { provide: ErrandService, useValue: noopErrandService },
        { provide: StickerCatalogService, useValue: emptyStickerCatalog },
        { provide: StickerGateService, useValue: noStickerGate },
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

  it('lo cuenta el modelo con frases naturales, a partir de las líneas agrupadas', async () => {
    graphUser.describe.mockResolvedValue([
      { relation: 'likes', label: 'Berserk', weight: 3 },
      { relation: 'asked_about', label: 'Solo Leveling', weight: 1 },
    ]);
    chat.describeMemory.mockResolvedValue('Sé que Berserk te vuela la cabeza y que andabas preguntando por Solo Leveling.');

    await invocar('!quesabes', 'Nico');
    await dejarCorrer();

    expect(chat.describeMemory).toHaveBeenCalledWith('Aria', 'Nico', [
      'Te gusta: Berserk',
      'Preguntaste por: Solo Leveling',
    ]);
    const enviado = socket.sendMessage.mock.calls.map((c) => String(c[0])).join(' ');
    expect(enviado).toContain('Berserk te vuela la cabeza');
    expect(enviado).not.toContain('Esto es lo que tengo guardado');
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('pedido otra vez antes de un minuto, manda la lista fija sin llamar al modelo', async () => {
    graphUser.describe.mockResolvedValue([{ relation: 'likes', label: 'Berserk', weight: 3 }]);
    chat.describeMemory.mockResolvedValue('Te encanta Berserk.');

    await invocar('!quesabes', 'Nico');
    await invocar('!quesabes', 'Nico');
    await dejarCorrer();

    expect(chat.describeMemory).toHaveBeenCalledTimes(1);
    const enviados = socket.sendMessage.mock.calls.map((c) => String(c[0]));
    expect(enviados.some((t) => t.includes('Esto es lo que tengo guardado'))).toBe(true);
  });

  it('"!quesabes" sin redacción del modelo cae a la lista agrupada', async () => {
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
    getReplyContext: jest.Mock;
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
      getReplyContext: jest.fn().mockReturnValue(null),
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
        BotOutputService,
        BotCommandsService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ChatService, useValue: chat },
        { provide: MusicService, useValue: {} },
        { provide: AniListService, useValue: {} },
        { provide: UtilsService, useValue: utils },
        { provide: LoggingService, useValue: logging },
        { provide: ChatSocketService, useValue: socket },
        { provide: GraphIngestService, useValue: ingest },
        { provide: GraphCacheService, useValue: {} },
        { provide: GraphService, useValue: noopGraphService },
        { provide: GraphUserService, useValue: graphUser },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: RateLimitService, useValue: { check: jest.fn().mockReturnValue(true) } },
        { provide: CrossContextSettingsService, useValue: noopCrossContextSettings },
        { provide: ErrandService, useValue: noopErrandService },
        { provide: StickerCatalogService, useValue: emptyStickerCatalog },
        { provide: StickerGateService, useValue: noStickerGate },
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
    getReplyContext: jest.Mock;
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
      getReplyContext: jest.fn().mockReturnValue(null),
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
        BotOutputService,
        BotCommandsService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ChatService, useValue: chat },
        { provide: MusicService, useValue: {} },
        { provide: AniListService, useValue: {} },
        { provide: UtilsService, useValue: utils },
        { provide: LoggingService, useValue: logging },
        { provide: ChatSocketService, useValue: socket },
        { provide: GraphIngestService, useValue: ingest },
        { provide: GraphCacheService, useValue: {} },
        { provide: GraphService, useValue: noopGraphService },
        { provide: GraphUserService, useValue: { describe: jest.fn().mockResolvedValue([]) } },
        { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: RateLimitService, useValue: rateLimit },
        { provide: CrossContextSettingsService, useValue: noopCrossContextSettings },
        { provide: ErrandService, useValue: noopErrandService },
        { provide: StickerCatalogService, useValue: emptyStickerCatalog },
        { provide: StickerGateService, useValue: noStickerGate },
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

  it('si el mensaje es un reply, le pasa al modelo el mensaje al que se responde', async () => {
    rateLimit.check.mockReturnValue(true);
    const contexto = { author: 'kei', content: 'terminé de leer Berserk anoche' };
    socket.getReplyContext.mockReturnValue(contexto);

    await invocar('bot qué opinás?', 'Nico', 'user');
    await dejarCorrer();

    expect(chat.chat).toHaveBeenCalledWith('bot qué opinás?', 'Aria', 'Nico', { replyTo: contexto });
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
    getReplyContext: jest.Mock;
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

  // Tres candidatas, no dos: MIN_CANDIDATES (3) es el mismo umbral que usa
  // GraphContextService.render para decidir si las muestra en la línea de
  // contexto (B2, ronda de corrección final) -- fixtures de 2 nunca superan
  // ese umbral, así que markCollaborativeRecommendations corta antes de
  // llegar al filtro de mención y los tests de acá abajo dejarían de
  // ejercitarlo sin que nadie lo notara.
  const CANDIDATOS: Candidate[] = [
    { key: 'vinland-saga', label: 'Vinland Saga', score: 5 },
    { key: 'berserk', label: 'Berserk', score: 3 },
    { key: 'orv', label: 'ORV', score: 2 },
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
        if (type === 'work' && key === 'orv') return Promise.resolve({ _id: 'orv-id' });
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
      getReplyContext: jest.fn().mockReturnValue(null),
      sendMessage: jest.fn(),
      sendMessageAndAwaitId: jest.fn().mockResolvedValue(null),
      deleteMessage: jest.fn(),
      getOnlineUsers: jest.fn().mockResolvedValue([]),
      username: 'Aria',
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BotService,
        BotOutputService,
        BotCommandsService,
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
        { provide: CrossContextSettingsService, useValue: noopCrossContextSettings },
        { provide: ErrandService, useValue: noopErrandService },
        { provide: StickerCatalogService, useValue: emptyStickerCatalog },
        { provide: StickerGateService, useValue: noStickerGate },
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
    // Berserk y ORV estaban entre las candidatas que devolvió collaborative,
    // pero el modelo no las mencionó: no se marcan. Marcar de más significaría
    // no volver a ofrecerlas más adelante, aunque nunca se hayan sugerido de
    // verdad.
    expect(graph.upsertEdge).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: 'berserk-id' }),
    );
    expect(graph.upsertEdge).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: 'orv-id' }),
    );
  });

  it('una candidata que el modelo no mencionó NO se marca', async () => {
    // Ninguna de las tres etiquetas aparece en el texto.
    chat.chat.mockResolvedValue('Qué buena pregunta, no tengo nada puntual para recomendarte hoy.');

    await invocar('bot recomendame algo', 'Nico');
    await dejarCorrer();

    // Si el marcado ignorara el filtro por mención (marcara toda candidata
    // que devuelve collaborative, se haya dicho o no), esta aserción fallaría.
    expect(graph.upsertEdge).not.toHaveBeenCalled();
  });

  it('si el modelo menciona dos de las tres candidatas, se marcan esas dos (y no la tercera)', async () => {
    chat.chat.mockResolvedValue('Te recomiendo Vinland Saga y también Berserk, ambas te van a encantar.');

    await invocar('bot recomendame algo', 'Nico');
    await dejarCorrer();

    expect(graph.upsertEdge).toHaveBeenCalledTimes(2);
    expect(graph.upsertEdge).toHaveBeenCalledWith(expect.objectContaining({ to: 'vinland-id' }));
    expect(graph.upsertEdge).toHaveBeenCalledWith(expect.objectContaining({ to: 'berserk-id' }));
    // ORV también estaba entre las candidatas (llegan las 3 al umbral de
    // MIN_CANDIDATES), pero el modelo no la mencionó.
    expect(graph.upsertEdge).not.toHaveBeenCalledWith(expect.objectContaining({ to: 'orv-id' }));
  });

  it('sin candidatas de collaborative, no marca nada', async () => {
    graph.collaborative.mockResolvedValue([]);
    chat.chat.mockResolvedValue('Vinland Saga es genial.');

    await invocar('bot recomendame algo', 'Nico');
    await dejarCorrer();

    expect(graph.upsertEdge).not.toHaveBeenCalled();
  });

  it('con menos de MIN_CANDIDATES no marca aunque el modelo mencione una candidata (B2, ronda de corrección final)', async () => {
    // Sólo 2 candidatas -- por debajo de MIN_CANDIDATES (3), el umbral que
    // usa GraphContextService.render para decidir si las muestra en la línea
    // de contexto. Con 2, el modelo nunca las vio como sugerencia: que
    // mencione "Vinland Saga" acá es casualidad (p. ej. una pregunta factual
    // sobre la obra), no una recomendación cumplida. Sin este mismo umbral en
    // el marcado, quedaría etiquetada recommended_to para siempre -- una
    // buena recomendación futura perdida en silencio, sin que nadie la haya
    // visto de verdad.
    graph.collaborative.mockResolvedValue([
      { key: 'vinland-saga', label: 'Vinland Saga', score: 5 },
      { key: 'berserk', label: 'Berserk', score: 3 },
    ]);
    chat.chat.mockResolvedValue('Deberías probar Vinland Saga, seguro te gusta.');

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
      // Dos candidatas de relleno (no mencionadas) sólo para llegar a
      // MIN_CANDIDATES -- por debajo de eso, markCollaborativeRecommendations
      // corta antes de llegar al filtro de mención que este test ejercita.
      graph.collaborative.mockResolvedValue([
        { key: 'air', label: 'Air', score: 4 },
        { key: 'vinland-saga', label: 'Vinland Saga', score: 2 },
        { key: 'orv', label: 'ORV', score: 1 },
      ]);
      chat.chat.mockResolvedValue('Che, hoy hace un aire fresco buenísimo para salir a caminar.');

      await invocar('bot recomendame algo', 'Nico');
      await dejarCorrer();

      // "air" es prefijo de "aire": sin exigir un límite de palabra real,
      // esta aserción fallaría porque la candidata se marcaría igual.
      expect(graph.upsertEdge).not.toHaveBeenCalled();
    });

    it('"Fate" NO se marca cuando sólo se mencionó "Fate/Zero" (candidata contenida en otra)', async () => {
      // Tercera candidata de relleno (no mencionada) sólo para llegar a
      // MIN_CANDIDATES -- ver comentario del test de "Air" arriba.
      graph.collaborative.mockResolvedValue([
        { key: 'fate', label: 'Fate', score: 3 },
        { key: 'fate-zero', label: 'Fate/Zero', score: 5 },
        { key: 'orv', label: 'ORV', score: 1 },
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
      // Tercera candidata de relleno (no mencionada) sólo para llegar a
      // MIN_CANDIDATES -- ver comentario del test de "Air" arriba.
      graph.collaborative.mockResolvedValue([
        { key: 'fate', label: 'Fate', score: 3 },
        { key: 'fate-zero', label: 'Fate/Zero', score: 5 },
        { key: 'orv', label: 'ORV', score: 1 },
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

/**
 * Arma un `BotService` con dobles por defecto para todas sus dependencias,
 * permitiendo overridear sólo lo que a cada test le importa (`crossContext`,
 * `errands`, `chat`, `rateLimit`). A diferencia de un primer intento con
 * `new BotService(...)` posicional, esto resuelve por TOKEN vía
 * `Test.createTestingModule` — mismo mecanismo que los 6 `describe` de
 * arriba —: si en el futuro se inserta una dependencia nueva en cualquier
 * posición del constructor, un `new(...)` posicional seguiría compilando con
 * los casts `as unknown as X` y cablearía el doble equivocado al parámetro
 * equivocado sin que ningún test lo note. Con DI por token, en cambio, falta
 * un provider y Nest tira "can't resolve dependencies" en la cara — ruidoso,
 * no silencioso. (Task 5: agregar `ErrandService` al constructor de
 * `BotService` es justamente lo que iba a activar esta red.)
 *
 * `sent` acumula todo lo que pasó por `chatSocketService.sendMessage` —
 * que es exactamente lo que emite `sendBotMessage` — para que los tests de
 * un solo comando (`!contextocruzado`) no necesiten un mock de socket propio.
 *
 * `errands` se devuelve también, para que los tests de entrega de recados
 * (Task 5) puedan aserir sobre `claimNext` sin tener que reconstruir el
 * doble ellos mismos.
 */
type CrossContextDouble = {
  isEnabled?: () => boolean;
  setOverride?: (value: boolean | null) => void;
  getInfo?: () => { enabled: boolean; source: 'env' | 'override' };
};

type ErrandDouble = {
  claimNext?: jest.Mock;
  setBotName?: jest.Mock;
};

type ChatDouble = {
  chat?: jest.Mock;
  deliverErrand?: jest.Mock;
  chatProactive?: jest.Mock;
  setSharedContextOverride?: jest.Mock;
  getSharedContextInfo?: jest.Mock;
};

type RateLimitDouble = {
  check?: jest.Mock;
  shouldNotifyRejection?: jest.Mock;
};

const buildBotService = async (
  overrides: {
    crossContext?: CrossContextDouble;
    errands?: ErrandDouble;
    chat?: ChatDouble;
    rateLimit?: RateLimitDouble;
    utils?: { splitMessageIntoParts?: jest.Mock };
    socket?: Record<string, unknown>;
    roomInstructions?: Record<string, jest.Mock>;
    usage?: Record<string, jest.Mock>;
    config?: Record<string, unknown>;
    stickers?: Record<string, unknown>;
    proactive?: Record<string, unknown>;
    logging?: Record<string, jest.Mock>;
  } = {},
): Promise<{
  service: BotService;
  sent: string[];
  errands: { claimNext: jest.Mock; setBotName: jest.Mock };
  chat: { chat: jest.Mock; deliverErrand: jest.Mock };
  utils: { splitMessageIntoParts: jest.Mock };
  socket: { getOnlineUsers: jest.Mock; username: string | undefined };
  logging: { getLastEventType: jest.Mock; clearMessagesLog: jest.Mock; saveLog: jest.Mock; getRecent?: jest.Mock };
}> => {
  const sent: string[] = [];
  const socket = {
    onMessage: jest.fn(),
    getReplyContext: jest.fn().mockReturnValue(null),
    sendMessage: jest.fn((text: string) => {
      sent.push(text);
    }),
    sendMessageAndAwaitId: jest.fn().mockResolvedValue(null),
    deleteMessage: jest.fn(),
    getOnlineUsers: jest.fn().mockResolvedValue([]),
    username: 'Aria' as string | undefined,
    ...overrides.socket,
  };

  // Doble de `LoggingService` con lo que toca el camino de `{{resumen}}`
  // (`getLastEventType` para el cooldown, `clearMessagesLog` para el borrado
  // del log). Existe para que ese camino sea OBSERVABLE en vez de explotar:
  // los tests de tokens de intención en la entrega afirman que NO se llega
  // acá. Aditivo — ningún test previo mira estos dobles.
  const logging = {
    saveLog: jest.fn().mockResolvedValue(undefined),
    getLastEventType: jest.fn().mockResolvedValue({ minutesLeft: 999 }),
    saveEventsLog: jest.fn().mockResolvedValue(undefined),
    clearMessagesLog: jest.fn().mockResolvedValue(0),
    ...overrides.logging,
  };

  const crossContext = {
    isEnabled: jest.fn().mockReturnValue(false),
    setOverride: jest.fn(),
    getInfo: jest.fn().mockReturnValue({ enabled: false, source: 'env' }),
    ...overrides.crossContext,
  };

  // Doble mínimo de `ErrandService` (Task 5): sin recado pendiente por
  // defecto, para que los describes que no ejercitan la entrega (todos salvo
  // el propio "entrega de recados") no vean cambio de comportamiento.
  const errands = {
    claimNext: jest.fn().mockResolvedValue(null),
    setBotName: jest.fn(),
    ...overrides.errands,
  };

  const chat = {
    chat: jest.fn().mockResolvedValue(''),
    deliverErrand: jest.fn().mockResolvedValue(''),
    ...overrides.chat,
  };

  const rateLimit = {
    check: jest.fn().mockReturnValue(true),
    shouldNotifyRejection: jest.fn().mockReturnValue(true),
    ...overrides.rateLimit,
  };

  // Se declara aparte (antes iba inline en el provider) para poder aserir
  // sobre `splitMessageIntoParts` desde los tests: es la señal observable de
  // que la entrega de un recado pasa por `handleChatResponse` y no por
  // `sendBotMessage` directo.
  const utils = {
    sleep: jest.fn().mockResolvedValue(undefined),
    splitMessageIntoParts: jest.fn((text: string) => [text]),
    ...overrides.utils,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      BotService,
      BotOutputService,
      BotCommandsService,
      { provide: ConfigService, useValue: { get: jest.fn((k: string) => overrides.config?.[k]) } },
      { provide: ChatService, useValue: chat },
      { provide: MusicService, useValue: {} },
      { provide: AniListService, useValue: {} },
      { provide: UtilsService, useValue: utils },
      { provide: LoggingService, useValue: logging },
      { provide: ChatSocketService, useValue: socket },
      { provide: GraphIngestService, useValue: { ingestSocial: jest.fn().mockResolvedValue(undefined) } },
      { provide: GraphCacheService, useValue: {} },
      { provide: GraphService, useValue: noopGraphService },
      { provide: GraphUserService, useValue: { describe: jest.fn().mockResolvedValue([]) } },
      { provide: UsageService, useValue: { record: jest.fn().mockResolvedValue(undefined), ...overrides.usage } },
      { provide: RateLimitService, useValue: rateLimit },
      { provide: CrossContextSettingsService, useValue: crossContext },
      { provide: ErrandService, useValue: errands },
      { provide: StickerCatalogService, useValue: { ...emptyStickerCatalog, ...overrides.stickers } },
      { provide: StickerGateService, useValue: noStickerGate },
      ...(overrides.roomInstructions
        ? [{ provide: RoomInstructionsService, useValue: overrides.roomInstructions }]
        : []),
      ...(overrides.proactive ? [{ provide: ProactiveService, useValue: overrides.proactive }] : []),
    ],
  }).compile();

  // No se llama a onModuleInit, mismo motivo que en los describes de arriba.
  const service = moduleRef.get<BotService>(BotService);

  return { service, sent, errands, chat, utils, socket, logging };
};

describe('!sharedcontext', () => {
  const dobles = (enabled: boolean, source: 'env' | 'override') => ({
    setSharedContextOverride: jest.fn(),
    getSharedContextInfo: jest.fn().mockReturnValue({ enabled, source }),
  });

  it('rechaza a quien no es admin y no toca el interruptor', async () => {
    const chat = dobles(false, 'env');
    const { service, sent } = await buildBotService({ chat });

    const handled = await service['commands']['handleSharedContextCommand']('!sharedcontext on', 'lyna', 'mod');

    expect(handled).toBe(true);
    expect(chat.setSharedContextOverride).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Solo admins');
  });

  it.each([
    ['on', true],
    ['off', false],
    ['reset', null],
  ])('un admin ejecuta "%s"', async (sub, esperado) => {
    const chat = dobles(false, 'env');
    const { service } = await buildBotService({ chat });

    await service['commands']['handleSharedContextCommand'](`!sharedcontext ${sub}`, 'leon', 'superAdmin');

    expect(chat.setSharedContextOverride).toHaveBeenCalledWith(esperado);
  });

  it('sin subcomando informa el estado y de dónde sale', async () => {
    const chat = dobles(true, 'override');
    const { service, sent } = await buildBotService({ chat });

    await service['commands']['handleSharedContextCommand']('!sharedcontext', 'leon', 'admin');

    expect(chat.setSharedContextOverride).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('activado (override en runtime)');
  });

  it('un subcomando desconocido muestra el uso', async () => {
    const chat = dobles(false, 'env');
    const { service, sent } = await buildBotService({ chat });

    await service['commands']['handleSharedContextCommand']('!sharedcontext quizas', 'leon', 'admin');

    expect(chat.setSharedContextOverride).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Uso:');
  });

  it('devuelve false para un mensaje que no es el comando, incluido !contextocruzado', async () => {
    const { service } = await buildBotService({});

    expect(await service['commands']['handleSharedContextCommand']('hola bot', 'leon', 'admin')).toBe(false);
    expect(await service['commands']['handleSharedContextCommand']('!contextocruzado on', 'leon', 'admin')).toBe(false);
  });
});

describe('!contextocruzado', () => {
  it('rechaza a quien no es admin y no toca el interruptor', async () => {
    const setOverride = jest.fn();
    const { service, sent } = await buildBotService({
      crossContext: { setOverride, getInfo: () => ({ enabled: false, source: 'env' }) },
    });

    await service['commands']['handleCrossContextCommand']('!contextocruzado on', 'lyna', 'user');

    expect(setOverride).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Solo admins');
  });

  it('un admin lo enciende', async () => {
    const setOverride = jest.fn();
    const { service } = await buildBotService({
      crossContext: { setOverride, getInfo: () => ({ enabled: true, source: 'override' }) },
    });

    const handled = await service['commands']['handleCrossContextCommand']('!contextocruzado on', 'leon', 'admin');

    expect(handled).toBe(true);
    expect(setOverride).toHaveBeenCalledWith(true);
  });

  it('reset devuelve el control al .env', async () => {
    const setOverride = jest.fn();
    const { service } = await buildBotService({
      crossContext: { setOverride, getInfo: () => ({ enabled: false, source: 'env' }) },
    });

    await service['commands']['handleCrossContextCommand']('!contextocruzado reset', 'leon', 'admin');

    expect(setOverride).toHaveBeenCalledWith(null);
  });

  it('devuelve false para un mensaje que no es el comando', async () => {
    const { service } = await buildBotService({});
    expect(await service['commands']['handleCrossContextCommand']('hola bot', 'leon', 'admin')).toBe(false);
  });
});

describe('entrega de recados', () => {
  it('entrega aunque el mensaje no mencione al bot, y CORTA (no era para el bot)', async () => {
    const { service, sent, errands, chat } = await buildBotService({
      crossContext: { isEnabled: () => true },
      errands: { claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: 'subí el video' }) },
    });

    await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

    expect(errands.claimNext).toHaveBeenCalledWith('lyna');
    expect(sent.join(' ')).toContain('subí el video');
    // Revisión de código (Important #3) — la rama "no interpela al bot" del
    // corte: sin esta aserción, un dispatcher que dejara de cortar acá (p.
    // ej. si alguien volviera a atar el corte al valor de retorno de
    // `deliverPendingErrand` en vez de al filtro de mención) seguiría
    // pasando el resto de este test igual.
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('Important #1 — un mensaje que SÍ interpela al bot entrega el recado Y además se sigue respondiendo', async () => {
    // Antes de este fix, `deliverPendingErrand` cortaba el dispatcher por su
    // cuenta con el supuesto (falso) de que "el mensaje no era para el bot".
    // Reproducido: con este mismo fixture, `chat.chat` recibía 0 llamadas y
    // la pregunta real de Lyna se perdía en silencio detrás del recado.
    const { service, sent, errands, chat } = await buildBotService({
      crossContext: { isEnabled: () => true },
      errands: { claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: 'subí el video' }) },
      chat: { chat: jest.fn().mockResolvedValue('respuesta del modelo') },
    });

    await service['handleNewChatMessage']({ content: 'bot como va', authorUsername: 'lyna' } as any);

    expect(errands.claimNext).toHaveBeenCalledWith('lyna');
    expect(sent.join(' ')).toContain('subí el video'); // el recado se entregó igual
    expect(chat.chat).toHaveBeenCalled(); // Y la pregunta real también se atendió
    expect(sent.join(' ')).toContain('respuesta del modelo');
  });

  it('Important #1 — un pedido de "usuarios online" con un recado pendiente también se atiende (no sólo menciones)', async () => {
    // Mismo hallazgo que el test de arriba, con otro de los disparadores que
    // NO son una mención textual del bot (`isOnlineReq`, ver el filtro más
    // abajo en el dispatcher) — la entrega no puede tragarse ninguno de
    // ellos, no sólo el caso de mención directa.
    const { service, sent, errands } = await buildBotService({
      crossContext: { isEnabled: () => true },
      errands: { claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: 'subí el video' }) },
    });

    await service['handleNewChatMessage']({
      content: 'usuarios en linea', authorUsername: 'lyna',
    } as any);

    expect(errands.claimNext).toHaveBeenCalledWith('lyna');
    expect(sent.join(' ')).toContain('subí el video'); // el recado se entregó
    // El fixture de `getOnlineUsers` (default de `buildBotService`) resuelve
    // vacío: esta línea es la respuesta real del fast-path de usuarios
    // online, prueba de que el dispatcher SIGUIÓ de largo tras entregar el
    // recado en vez de cortar.
    expect(sent.join(' ')).toContain('No hay nadie conectado');
  });

  it('ya no depende de CROSS_USER_CONTEXT: con el flag apagado también entrega', async () => {
    const { service, errands } = await buildBotService({
      crossContext: { isEnabled: () => false },
      errands: { claimNext: jest.fn().mockResolvedValue(null) },
    });

    await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

    expect(errands.claimNext).toHaveBeenCalledWith('lyna');
  });

  it('no consume el cupo del destinatario', async () => {
    const check = jest.fn().mockReturnValue(true);
    const { service } = await buildBotService({
      crossContext: { isEnabled: () => true },
      errands: { claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: 'x' }) },
      rateLimit: { check },
    });

    await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

    expect(check).not.toHaveBeenCalled();
  });

  it('Important #2 — cuando el modelo redacta bien, entrega ESE texto (no el fallback fijo)', async () => {
    // Sin este test, la rama feliz de la entrega (la que corre en
    // producción cuando el modelo SÍ responde) no tenía cobertura propia:
    // los dos tests de este describe que sí invocan `deliverPendingErrand`
    // pasan por el fallback (`deliverErrand` mockeado a `''`, ver el default
    // de `buildBotService`). Verificado con un mutante: reemplazar
    // `@${authorUsername} ${drafted}` por basura en esa rama deja la
    // suite en verde si no hay una aserción sobre el texto exacto que
    // redactó el modelo.
    const drafted = 'Che, leon te dejó dicho que subas el video.';
    const { service, sent } = await buildBotService({
      crossContext: { isEnabled: () => true },
      errands: { claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: 'subí el video' }) },
      chat: { deliverErrand: jest.fn().mockResolvedValue(drafted) },
    });

    await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

    expect(sent.join(' ')).toContain(drafted);
    // El patrón del fallback fijo ("te dejó dicho:") NO debe aparecer — si
    // apareciera, sería señal de que se ignoró el texto del modelo.
    expect(sent.join(' ')).not.toContain('te dejó dicho:');
  });

  it('si el modelo falla, igual entrega el recado con texto fijo', async () => {
    const { service, sent } = await buildBotService({
      crossContext: { isEnabled: () => true },
      errands: { claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: 'subí el video' }) },
      chat: { deliverErrand: jest.fn().mockResolvedValue('') },
    });

    await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

    expect(sent.join(' ')).toContain('subí el video');
    expect(sent.join(' ')).toContain('leon');
  });

  it('un recado secreto se entrega sin nombrar al autor (también en el texto fijo)', async () => {
    const deliverErrand = jest.fn().mockResolvedValue('');
    const { service, sent } = await buildBotService({
      errands: {
        claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: 'tu gato se escapó', secret: true }),
      },
      chat: { deliverErrand },
    });

    await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

    expect(deliverErrand).toHaveBeenCalledWith(expect.any(String), 'lyna', 'leon', 'tu gato se escapó', true);
    expect(sent.join(' ')).toContain('tu gato se escapó');
    expect(sent.join(' ')).not.toContain('leon');
    expect(sent.join(' ')).not.toContain('te dejó dicho');
  });

  describe('recado con sticker', () => {
    const stickers = {
      findByName: (n: string) => (n.toLowerCase() === 'gato llorando' ? { code: 'stk_gato1', name: 'Gato llorando' } : null),
      nameForCode: (c: string) => (c === 'stk_gato1' ? 'Gato llorando' : null),
    };

    it('secreto y sólo sticker: lo manda en un mensaje, sin llamar al modelo ni nombrar al autor', async () => {
      const deliverErrand = jest.fn().mockResolvedValue('no debería usarse');
      const { service, sent } = await buildBotService({
        errands: {
          claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: '[sticker: Gato llorando]', secret: true }),
        },
        chat: { deliverErrand },
        stickers,
      });

      await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'Victoria949H' } as any);

      expect(deliverErrand).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(':stk_gato1:');
      expect(sent[0]).toContain('Victoria949H');
      expect(sent[0]).not.toContain('leon');
    });

    it('con texto: el modelo redacta el texto sin el sticker y el sticker va en el mismo mensaje', async () => {
      const deliverErrand = jest.fn().mockResolvedValue('Che, leon dice que te extraña');
      const { service, sent } = await buildBotService({
        errands: {
          claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: 'que te extraña [sticker: Gato llorando]', secret: false }),
        },
        chat: { deliverErrand },
        stickers,
      });

      await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

      expect(deliverErrand).toHaveBeenCalledWith(expect.any(String), 'lyna', 'leon', 'que te extraña', false);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('Che, leon dice que te extraña');
      expect(sent[0]).toContain(':stk_gato1:');
    });

    it('un sticker que no existe queda como texto', async () => {
      const deliverErrand = jest.fn().mockResolvedValue('');
      const { service, sent } = await buildBotService({
        errands: {
          claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: '[sticker: Perro bailando]', secret: true }),
        },
        chat: { deliverErrand },
        stickers,
      });

      await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

      expect(deliverErrand).toHaveBeenCalledWith(expect.any(String), 'lyna', 'leon', '[sticker: Perro bailando]', true);
      expect(sent.join(' ')).not.toContain(':stk_');
    });
  });

  it('no entrega recados a un autor con role bot', async () => {
    const { service, errands } = await buildBotService({
      crossContext: { isEnabled: () => true },
      errands: { claimNext: jest.fn() },
    });

    await service['handleNewChatMessage']({
      content: 'hola', authorUsername: 'otrobot', authorRole: 'bot',
    } as any);

    expect(errands.claimNext).not.toHaveBeenCalled();
  });

  // ─── Revisión final de rama (CRITICAL, tercera parte) ────────────────────

  describe('la entrega pasa por handleChatResponse, no por sendBotMessage directo', () => {
    // El camino directo salteaba el partido por `maxLengthResponse` y la
    // limpieza de tokens de intención: un recado largo se publicaba entero
    // (por encima del tope del chat) y un `{{music:…}}` en el texto salía
    // crudo con la identidad del bot.
    it('el texto redactado por el modelo se parte por maxLengthResponse', async () => {
      const { service, sent, utils } = await buildBotService({
        crossContext: { isEnabled: () => true },
        errands: { claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: 'subí el video' }) },
        chat: { deliverErrand: jest.fn().mockResolvedValue('parte uno parte dos') },
        utils: { splitMessageIntoParts: jest.fn(() => ['parte uno', 'parte dos']) },
      });

      await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

      // Antes: UNA sola llamada a sendMessage con el texto entero, sin pasar
      // nunca por el partidor.
      expect(utils.splitMessageIntoParts).toHaveBeenCalledWith('parte uno parte dos', LYNA_SPLIT_BUDGET);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain('parte uno');
      expect(sent[1]).toContain('parte dos');
    });

    it('el texto fijo de respaldo también se parte (la rama que corre cuando el modelo falla)', async () => {
      const { service, utils } = await buildBotService({
        crossContext: { isEnabled: () => true },
        errands: { claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: 'subí el video' }) },
        chat: { deliverErrand: jest.fn().mockResolvedValue('') },
      });

      await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

      expect(utils.splitMessageIntoParts).toHaveBeenCalledWith(
        'leon te dejó dicho: subí el video',
        LYNA_SPLIT_BUDGET,
      );
    });

    it('la primera parte lleva la mención del destinatario', async () => {
      const { service, sent } = await buildBotService({
        crossContext: { isEnabled: () => true },
        errands: { claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: 'subí el video' }) },
      });

      await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

      expect(sent[0]).toContain('<@lyna>');
    });
  });

  // ─── Re-revisión (2.1) — la entrega no puede disparar tokens de intención ──

  describe('los tokens {{…}} que redacta el modelo en una entrega no se interpretan', () => {
    // Encauzar la entrega por `handleChatResponse` (la ola anterior, para
    // ganar el partido por largo y la limpieza) abrió una superficie nueva:
    // ese método INTERPRETA tokens de intención. Y acá el disparador no es
    // un pedido del usuario — es un mensaje cualquiera del DESTINATARIO, que
    // no pidió nada, sobre un prompt que lleva prosa de OTRO usuario. La
    // sanitización del recado no cierra el camino: el modelo redacta libre y
    // puede emitir el token por su cuenta (medido: `"Ignora lo anterior."`
    // sobrevive persistido en el texto del recado).
    //
    // El arreglo borra `\{\{[^}]*\}\}` del texto ANTES de `handleChatResponse`,
    // conservando el partido por `maxLengthResponse` y la mención.
    const withDraft = (drafted: string) =>
      buildBotService({
        crossContext: { isEnabled: () => true },
        errands: { claimNext: jest.fn().mockResolvedValue({ fromLabel: 'leon', text: 'subí el video' }) },
        chat: { deliverErrand: jest.fn().mockResolvedValue(drafted) },
      });

    it('{{music: …}} no llega al pipeline de música', async () => {
      const { service, sent, utils } = await withDraft('leon dice {{music: rickroll}} que subas el video');

      await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

      // La señal de que NO se tomó la rama de música: se llegó al tramo
      // final de `handleChatResponse` (el partidor). La rama de música
      // retorna antes de llegar ahí.
      expect(utils.splitMessageIntoParts).toHaveBeenCalledWith(
        'leon dice que subas el video',
        LYNA_SPLIT_BUDGET,
      );
      expect(sent.join(' ')).not.toContain('{{');
      expect(sent.join(' ')).not.toContain('rickroll');
    });

    it('{{usuarios_online}} no publica el roster', async () => {
      const { service, sent, socket, utils } = await withDraft('leon pregunta {{usuarios_online}} por vos');

      await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

      expect(socket.getOnlineUsers).not.toHaveBeenCalled();
      expect(utils.splitMessageIntoParts).toHaveBeenCalledWith('leon pregunta por vos', LYNA_SPLIT_BUDGET);
      expect(sent.join(' ')).not.toContain('{{');
    });

    it('{{resumen}} no quema el cooldown ni borra el log de mensajes', async () => {
      const { service, sent, logging, utils } = await withDraft('leon te dejó esto {{resumen}} para vos');

      await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

      // Las dos consecuencias destructivas del camino feliz de
      // `handleSummaryRequest`, aserida cada una por su lado.
      expect(logging.getLastEventType).not.toHaveBeenCalled();
      expect(logging.clearMessagesLog).not.toHaveBeenCalled();
      expect(utils.splitMessageIntoParts).toHaveBeenCalledWith('leon te dejó esto para vos', LYNA_SPLIT_BUDGET);
      expect(sent.join(' ')).not.toContain('{{');
    });

    it('si el token era TODO el texto redactado, cae al texto fijo (no se manda una mención pelada)', async () => {
      const { service, sent } = await withDraft('{{resumen}}');

      await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

      expect(sent.join(' ')).toContain('leon te dejó dicho: subí el video');
      expect(sent.join(' ')).not.toContain('{{');
    });

    it('un texto sin tokens llega intacto (la limpieza no puede tocar el caso normal)', async () => {
      const { service, utils } = await withDraft('Che,  leon te dejó dicho que subas el video.');

      await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

      // Doble espacio incluido: sin tokens, el texto se pasa TAL CUAL, sin
      // normalizar espacios ni recortar.
      expect(utils.splitMessageIntoParts).toHaveBeenCalledWith(
        'Che,  leon te dejó dicho que subas el video.',
        LYNA_SPLIT_BUDGET,
      );
    });
  });

  // ─── Revisión final de rama (deuda #3) ───────────────────────────────────

  it('le informa a ErrandService su propio nombre, para que pueda rechazarse como destinatario', async () => {
    const { service, errands } = await buildBotService({
      crossContext: { isEnabled: () => false },
    });

    await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

    expect(errands.setBotName).toHaveBeenCalledWith('Aria');
  });

  // ─── Re-revisión (2.6) — el guard de setBotName no estaba cubierto ───────
  //
  // `if (this.chatSocketService.username)` protege un caso concreto: mientras
  // el socket todavía no sabe su nombre, `botUsername` cae al literal `'bot'`
  // (un fallback pensado para los regex de mención). Pasarle ESE fallback a
  // `ErrandService.setBotName` haría que un usuario que se llame literalmente
  // "bot" quedara marcado como el bot y no pudiera recibir recados.
  //
  // Medido antes de escribir esto: cambiar el guard por una llamada
  // incondicional `setBotName(this.chatSocketService.username ?? 'bot')`
  // dejaba la suite entera en verde — la razón declarada del guard no estaba
  // fijada por nada.
  it('mientras el socket no sabe su nombre, NO le pasa el fallback "bot" a ErrandService', async () => {
    const { service, errands } = await buildBotService({
      crossContext: { isEnabled: () => false },
      socket: { username: undefined },
    });

    await service['handleNewChatMessage']({ content: 'hola gente', authorUsername: 'lyna' } as any);

    // Ni con el fallback ni con nada: mientras no se sepa de verdad, el
    // guard de `ErrandService` simplemente no aplica.
    expect(errands.setBotName).not.toHaveBeenCalled();
  });
});

describe('BotService — entrega de canciones', () => {
  let service: BotService;
  let chat: { chat: jest.Mock; songDeliveryLine: jest.Mock; rememberSongSent: jest.Mock };
  let music: { processMusic: jest.Mock; getQueueStatus: jest.Mock };
  let socket: {
    onMessage: jest.Mock;
    getReplyContext: jest.Mock;
    sendMessage: jest.Mock;
    sendMessageAndAwaitId: jest.Mock;
    deleteMessage: jest.Mock;
    username: string;
  };

  const track = {
    title: 'Ita Song',
    artist: 'Yorushika',
    thumb: null,
    youtubeUrl: null,
    uploadUrl: 'https://files.catbox.moe/x.mp3',
    uploadService: 'catbox',
  };
  const media = '[audio title="Ita Song"]https://files.catbox.moe/x.mp3[/audio]';

  beforeEach(async () => {
    chat = {
      chat: jest.fn(),
      songDeliveryLine: jest.fn().mockResolvedValue('¡Ahí va! 🎧'),
      rememberSongSent: jest.fn().mockResolvedValue(undefined),
    };
    music = {
      processMusic: jest.fn().mockResolvedValue({ text: 'TEXTO FIJO', track, media }),
      getQueueStatus: jest.fn(),
    };
    socket = {
      onMessage: jest.fn(),
      getReplyContext: jest.fn().mockReturnValue(null),
      sendMessage: jest.fn(),
      sendMessageAndAwaitId: jest.fn().mockResolvedValue('buscando-id'),
      deleteMessage: jest.fn(),
      username: 'Aria',
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BotService,
        BotOutputService,
        BotCommandsService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ChatService, useValue: chat },
        { provide: MusicService, useValue: music },
        { provide: AniListService, useValue: {} },
        { provide: UtilsService, useValue: { sleep: jest.fn().mockResolvedValue(undefined) } },
        { provide: LoggingService, useValue: {} },
        { provide: ChatSocketService, useValue: socket },
        { provide: GraphIngestService, useValue: { ingestTrack: jest.fn().mockResolvedValue(undefined) } },
        { provide: GraphCacheService, useValue: {} },
        { provide: GraphService, useValue: noopGraphService },
        { provide: GraphUserService, useValue: {} },
        { provide: UsageService, useValue: {} },
        { provide: RateLimitService, useValue: {} },
        { provide: CrossContextSettingsService, useValue: noopCrossContextSettings },
        { provide: ErrandService, useValue: noopErrandService },
        { provide: StickerCatalogService, useValue: emptyStickerCatalog },
        { provide: StickerGateService, useValue: noStickerGate },
      ],
    }).compile();

    service = moduleRef.get<BotService>(BotService);
  });

  type ConMusica = { handleMusicRequest(message: string, authorUsername: string): Promise<void> };
  const pedir = async (message: string) => {
    await (service as unknown as ConMusica).handleMusicRequest(message, 'Nico');
    // processMusic(...).then(...) no se espera dentro de handleMusicRequest.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };

  it('entrega con la frase del modelo + el reproductor, sin repetir el título fijo', async () => {
    await pedir('!music yorushika');

    expect(chat.songDeliveryLine).toHaveBeenCalledWith('Aria', 'Nico', {
      title: 'Ita Song',
      artist: 'Yorushika',
      query: 'yorushika',
    });
    expect(socket.deleteMessage).toHaveBeenCalledWith('buscando-id');
    expect(socket.sendMessage).toHaveBeenLastCalledWith(
      expect.stringContaining(`🎵 <@Nico> ¡Ahí va! 🎧 ${media}`),
    );
    expect(socket.sendMessage).not.toHaveBeenCalledWith(expect.stringContaining('TEXTO FIJO'));
  });

  it('recuerda la canción enviada en el historial', async () => {
    await pedir('!music yorushika');

    expect(chat.rememberSongSent).toHaveBeenCalledWith(
      'Nico',
      { title: 'Ita Song', artist: 'Yorushika', query: 'yorushika' },
      '¡Ahí va! 🎧',
    );
  });

  it('si el modelo no redacta nada, sale el texto fijo de siempre', async () => {
    chat.songDeliveryLine.mockResolvedValue('');

    await pedir('!music yorushika');

    expect(socket.sendMessage).toHaveBeenLastCalledWith(expect.stringContaining('TEXTO FIJO'));
    expect(chat.rememberSongSent).toHaveBeenCalledWith('Nico', expect.anything(), '');
  });

  it('sin pista (subida caída) no llama al modelo ni guarda nada', async () => {
    music.processMusic.mockResolvedValue({ text: 'SE PROCESÓ PERO…', track: null });

    await pedir('!music yorushika');

    expect(chat.songDeliveryLine).not.toHaveBeenCalled();
    expect(chat.rememberSongSent).not.toHaveBeenCalled();
    expect(socket.sendMessage).toHaveBeenLastCalledWith(expect.stringContaining('SE PROCESÓ PERO…'));
  });
});

describe('instrucciones de sala (!instruccion / !instrucciones)', () => {
  const dobles = (list: Array<{ text: string; createdBy: string; source: 'command' | 'model' }> = []) => ({
    list: jest.fn().mockResolvedValue(list),
    add: jest.fn().mockResolvedValue({ ok: true, position: list.length + 1 }),
    removeAt: jest.fn().mockImplementation(async (n: number) => list[n - 1] ?? null),
    clear: jest.fn().mockResolvedValue(list.length),
  });
  const handle = (service: BotService, content: string, role?: string) =>
    service['commands']['handleRoomInstructionsCommand'](content, 'leon', role);

  it('no toca mensajes que no son el comando', async () => {
    const { service } = await buildBotService({ roomInstructions: dobles() });
    expect(await handle(service, 'bot hola', 'admin')).toBe(false);
    expect(await handle(service, '!instruccionesxyz', 'admin')).toBe(false);
  });

  it('lista numerada para mods y admins', async () => {
    const roomInstructions = dobles([
      { text: 'Respondé con colores.', createdBy: 'leon', source: 'command' },
      { text: 'Usá emojis.', createdBy: 'kei', source: 'model' },
    ]);
    const { service, sent } = await buildBotService({ roomInstructions });

    await handle(service, '!instrucciones', 'mod');

    const out = sent.join('\n');
    expect(out).toContain('1. Respondé con colores. (de leon)');
    expect(out).toContain('2. Usá emojis. (de kei)');
  });

  it('la lista vacía lo dice', async () => {
    const { service, sent } = await buildBotService({ roomInstructions: dobles() });
    await handle(service, '!instrucciones', 'admin');
    expect(sent.join(' ')).toContain('No hay instrucciones');
  });

  it('un usuario común no ve ni cambia nada', async () => {
    const roomInstructions = dobles();
    const { service, sent } = await buildBotService({ roomInstructions });

    await handle(service, '!instrucciones', 'user');
    await handle(service, '!instruccion respondé en verso', 'user');

    expect(roomInstructions.list).not.toHaveBeenCalled();
    expect(roomInstructions.add).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Solo mods y admins');
  });

  it('un mod no puede agregar por comando', async () => {
    const roomInstructions = dobles();
    const { service, sent } = await buildBotService({ roomInstructions });
    await handle(service, '!instruccion respondé en verso', 'mod');
    expect(roomInstructions.add).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Solo admins');
  });

  it.each(['!instruccion Respondé a todos con colores', '!instrucción Respondé a todos con colores'])(
    'un admin agrega con "%s"',
    async (cmd) => {
      const roomInstructions = dobles();
      const { service, sent } = await buildBotService({ roomInstructions });
      await handle(service, cmd, 'superAdmin');
      expect(roomInstructions.add).toHaveBeenCalledWith('Respondé a todos con colores', 'leon', 'command', null);
      expect(sent.join(' ')).toContain('Instrucción 1 guardada');
    },
  );

  it.each(['quitar 2', 'borrar 2', 'eliminar #2'])('un admin quita por número con "%s"', async (sub) => {
    const roomInstructions = dobles([
      { text: 'a', createdBy: 'leon', source: 'command' },
      { text: 'b', createdBy: 'leon', source: 'command' },
    ]);
    const { service, sent } = await buildBotService({ roomInstructions });
    await handle(service, `!instruccion ${sub}`, 'admin');
    expect(roomInstructions.removeAt).toHaveBeenCalledWith(2);
    expect(sent.join(' ')).toContain('Quité la instrucción 2: "b"');
  });

  it('quitar un número que no existe avisa', async () => {
    const { service, sent } = await buildBotService({ roomInstructions: dobles() });
    await handle(service, '!instruccion quitar 5', 'admin');
    expect(sent.join(' ')).toContain('No hay instrucción número 5');
  });

  it('"quitar" sin número muestra el uso y no lo guarda como instrucción', async () => {
    const roomInstructions = dobles();
    const { service, sent } = await buildBotService({ roomInstructions });
    await handle(service, '!instruccion quitar', 'admin');
    expect(roomInstructions.add).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Uso:');
  });

  it('reset borra todas', async () => {
    const roomInstructions = dobles([{ text: 'a', createdBy: 'leon', source: 'command' }]);
    const { service, sent } = await buildBotService({ roomInstructions });
    await handle(service, '!instrucciones reset', 'admin');
    expect(roomInstructions.clear).toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Borré 1 instrucción');
  });

  it('el plural con algo raro muestra el uso en vez de guardarlo', async () => {
    const roomInstructions = dobles();
    const { service, sent } = await buildBotService({ roomInstructions });
    await handle(service, '!instrucciones usá colores', 'admin');
    expect(roomInstructions.add).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Uso:');
  });

  it('el comando funciona sin mencionar al bot y no llama al modelo', async () => {
    const roomInstructions = dobles();
    const { service, chat } = await buildBotService({ roomInstructions });
    await service['handleNewChatMessage']({
      content: '!instruccion usá colores',
      authorUsername: 'leon',
      authorRole: 'admin',
    } as ChatMessage);
    expect(roomInstructions.add).toHaveBeenCalled();
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('al staff le pasa canInstruct al modelo; a un invitado no', async () => {
    const { service, chat } = await buildBotService({ roomInstructions: dobles() });

    await service['handleNewChatMessage']({ content: 'bot hola', authorUsername: 'leon', authorRole: 'mod' } as ChatMessage);
    await service['handleNewChatMessage']({ content: 'bot hola', authorUsername: 'nico', authorRole: 'guest' } as ChatMessage);

    expect(chat.chat.mock.calls[0][3]).toEqual(expect.objectContaining({ canInstruct: true }));
    expect(chat.chat.mock.calls[1][3]).toBeUndefined();
  });
});

describe('instrucciones de sala con vencimiento', () => {
  const dobles = (list: Array<{ text: string; createdBy: string; source: 'command' | 'model'; expiresAt: Date | null }> = []) => ({
    list: jest.fn().mockResolvedValue(list),
    add: jest.fn().mockResolvedValue({ ok: true, position: list.length + 1 }),
    removeAt: jest.fn(),
    clear: jest.fn(),
  });

  it('"!instruccion 2h <texto>" guarda con vencimiento y lo confirma', async () => {
    const roomInstructions = dobles();
    const { service, sent } = await buildBotService({ roomInstructions });
    await service['commands']['handleRoomInstructionsCommand']('!instruccion 2h Respondé con colores', 'leon', 'admin');
    expect(roomInstructions.add).toHaveBeenCalledWith('Respondé con colores', 'leon', 'command', 2 * 3_600_000);
    expect(sent.join(' ')).toContain('durante 2h');
  });

  it('"!instruccion 2h" sin texto muestra el uso', async () => {
    const roomInstructions = dobles();
    const { service, sent } = await buildBotService({ roomInstructions });
    await service['commands']['handleRoomInstructionsCommand']('!instruccion 2h', 'leon', 'admin');
    expect(roomInstructions.add).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Uso:');
  });

  it('una primera palabra que no es duración es parte del texto', async () => {
    const roomInstructions = dobles();
    const { service } = await buildBotService({ roomInstructions });
    await service['commands']['handleRoomInstructionsCommand']('!instruccion Hablá en verso', 'leon', 'admin');
    expect(roomInstructions.add).toHaveBeenCalledWith('Hablá en verso', 'leon', 'command', null);
  });

  it('la lista muestra cuánto falta para que venza', async () => {
    const roomInstructions = dobles([
      { text: 'temporal', createdBy: 'leon', source: 'command', expiresAt: new Date(Date.now() + 90 * 60_000 + 30_000) },
    ]);
    const { service, sent } = await buildBotService({ roomInstructions });
    await service['commands']['handleRoomInstructionsCommand']('!instrucciones', 'leon', 'admin');
    expect(sent.join(' ')).toContain('1. temporal (de leon, vence en 1h 30m)');
  });
});

describe('formatRemaining', () => {
  it.each([
    [30_000, 'menos de 1m'],
    [45 * 60_000, '45m'],
    [60 * 60_000, '1h'],
    [80 * 60_000, '1h 20m'],
    [24 * 3_600_000, '1d'],
    [51 * 3_600_000, '2d 3h'],
  ])('%d ms → %s', (ms, out) => {
    expect(formatRemaining(ms)).toBe(out);
  });
});

describe('!ayuda', () => {
  it('a un invitado le muestra sólo los comandos generales', async () => {
    const { service, sent } = await buildBotService();
    expect(await service['commands']['handleHelpCommand']('!ayuda', 'nico', 'guest')).toBe(true);
    const out = sent.join('\n');
    expect(out).toContain('!music');
    expect(out).toContain('!quesabes');
    expect(out).not.toContain('!instrucciones');
    expect(out).not.toContain('!uso');
  });

  it('a un mod le suma la sección de staff, no la de admin', async () => {
    const { service, sent } = await buildBotService();
    await service['commands']['handleHelpCommand']('!help', 'kei', 'mod');
    const out = sent.join('\n');
    expect(out).toContain('!instrucciones');
    expect(out).not.toContain('!uso');
  });

  it('a un admin le muestra todo, y !video sólo si está activo', async () => {
    const { service, sent } = await buildBotService({ config: { 'video.enabled': true } });
    await service['commands']['handleHelpCommand']('!comandos', 'leon', 'superAdmin');
    const out = sent.join('\n');
    expect(out).toContain('!uso');
    expect(out).toContain('!sharedcontext');
    expect(out).toContain('!video');
  });

  it('no toca otros mensajes', async () => {
    const { service } = await buildBotService();
    expect(await service['commands']['handleHelpCommand']('!ayudame con esto', 'nico', 'guest')).toBe(false);
  });
});

describe('!uso', () => {
  const resumen = {
    calls: 12,
    promptTokens: 20000,
    completionTokens: 3000,
    topUsers: [{ user: 'nico', calls: 8, tokens: 15000 }],
    oldest: new Date(0),
  };

  it('rechaza a quien no es admin', async () => {
    const usage = { summarize: jest.fn() };
    const { service, sent } = await buildBotService({ usage });
    await service['commands']['handleUsageCommand']('!uso', 'kei', 'mod');
    expect(usage.summarize).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Solo admins');
  });

  it('muestra totales y top; sin precio no muestra costo', async () => {
    const usage = { summarize: jest.fn().mockResolvedValue(resumen) };
    const { service, sent } = await buildBotService({ usage });
    await service['commands']['handleUsageCommand']('!uso 7d', 'leon', 'admin');

    const since = usage.summarize.mock.calls[0][0] as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    const out = sent.join('\n');
    expect(out).toContain('últimos 7 días');
    expect(out).toContain('12 llamadas');
    expect(out).toContain('1. nico');
    expect(out).not.toContain('Costo');
  });

  it('con precio configurado estima el costo', async () => {
    const usage = { summarize: jest.fn().mockResolvedValue(resumen) };
    const { service, sent } = await buildBotService({
      usage,
      config: { 'bot.llmPriceInputPerM': 1, 'bot.llmPriceOutputPerM': 4 },
    });
    await service['commands']['handleUsageCommand']('!uso', 'leon', 'admin');
    // 20000 * 1 / 1M + 3000 * 4 / 1M = 0.032
    expect(sent.join(' ')).toContain('US$ 0.0320');
  });

  it('con precio de caché, la entrada cacheada se cobra aparte', async () => {
    const usage = { summarize: jest.fn().mockResolvedValue({ ...resumen, cachedPromptTokens: 15000 }) };
    const { service, sent } = await buildBotService({
      usage,
      config: { 'bot.llmPriceInputPerM': 1, 'bot.llmPriceOutputPerM': 4, 'bot.llmPriceCachedInputPerM': 0.02 },
    });
    await service['commands']['handleUsageCommand']('!uso', 'leon', 'admin');
    // 5000 * 1 + 15000 * 0.02 + 3000 * 4 = 17300 → /1M = 0.0173
    const out = sent.join(' ');
    expect(out).toContain('US$ 0.0173');
    expect(out).toContain('15.000 desde caché');
  });

  it('sin precio de caché, la entrada cacheada se cobra como entrada normal', async () => {
    const usage = { summarize: jest.fn().mockResolvedValue({ ...resumen, cachedPromptTokens: 15000 }) };
    const { service, sent } = await buildBotService({
      usage,
      config: { 'bot.llmPriceInputPerM': 1, 'bot.llmPriceOutputPerM': 4 },
    });
    await service['commands']['handleUsageCommand']('!uso', 'leon', 'admin');
    expect(sent.join(' ')).toContain('US$ 0.0320');
  });

  it('avisa si los registros no cubren toda la ventana', async () => {
    const usage = { summarize: jest.fn().mockResolvedValue({ ...resumen, oldest: new Date(Date.now() - 3_600_000) }) };
    const { service, sent } = await buildBotService({ usage });
    await service['commands']['handleUsageCommand']('!uso 30d', 'leon', 'admin');
    expect(sent.join(' ')).toContain('Solo hay registros desde');
  });

  it.each(['!uso 3x', '!uso constructor'])('ventana inválida (%s) muestra el uso', async (cmd) => {
    const usage = { summarize: jest.fn() };
    const { service, sent } = await buildBotService({ usage });
    await service['commands']['handleUsageCommand'](cmd, 'leon', 'admin');
    expect(usage.summarize).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Uso: !uso');
  });

  it('si Mongo falla avisa en vez de tirar el proceso', async () => {
    const usage = { summarize: jest.fn().mockRejectedValue(new Error('mongo caído')) };
    const { service, sent } = await buildBotService({ usage });
    await expect(service['commands']['handleUsageCommand']('!uso', 'leon', 'admin')).resolves.toBe(true);
    expect(sent.join(' ')).toContain('No pude leer el consumo');
  });
});

describe('escribiendo… y reacciones', () => {
  const msg = (over: Partial<ChatMessage> = {}) =>
    ({ _id: 'm1', content: 'bot jaja', authorUsername: 'nico', authorRole: 'user', ...over }) as ChatMessage;

  it('muestra "escribiendo…" mientras el modelo piensa y lo corta al terminar', async () => {
    const stop = jest.fn();
    const startTyping = jest.fn().mockReturnValue(stop);
    const { service, chat } = await buildBotService({ socket: { startTyping } });
    chat.chat.mockImplementation(async () => {
      expect(startTyping).toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      return 'hola';
    });

    await service['handleNewChatMessage'](msg());
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('lo corta aunque el modelo falle', async () => {
    const stop = jest.fn();
    const { service, chat } = await buildBotService({ socket: { startTyping: () => stop } });
    chat.chat.mockRejectedValue(new Error('boom'));

    await expect(service['handleNewChatMessage'](msg())).rejects.toThrow('boom');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('con reacciones activas las ofrece y reacciona al mensaje', async () => {
    const toggleReaction = jest.fn();
    const { service, chat, sent } = await buildBotService({ socket: { reactionsEnabled: true, toggleReaction } });
    chat.chat.mockResolvedValue('{{react:😂}}');

    await service['handleNewChatMessage'](msg());

    expect(chat.chat.mock.calls[0][3]).toEqual(expect.objectContaining({ reactions: true }));
    expect(toggleReaction).toHaveBeenCalledWith('m1', '😂');
    expect(sent).toEqual([]); // sólo reacción, sin texto
  });

  it('reacción + texto: reacciona y además responde sin el token', async () => {
    const toggleReaction = jest.fn();
    const { service, chat, utils } = await buildBotService({ socket: { reactionsEnabled: true, toggleReaction } });
    chat.chat.mockResolvedValue('buenísimo {{react:🔥}}');

    await service['handleNewChatMessage'](msg());

    expect(toggleReaction).toHaveBeenCalledWith('m1', '🔥');
    expect(utils.splitMessageIntoParts.mock.calls[0][0]).not.toContain('{{react');
  });

  it('con reacciones apagadas no las ofrece', async () => {
    const { service, chat } = await buildBotService({ socket: { reactionsEnabled: false } });
    chat.chat.mockResolvedValue('hola');
    await service['handleNewChatMessage'](msg());
    expect(chat.chat.mock.calls[0][3]).toBeUndefined();
  });
});

describe('recados: !misrecados / !cancelarrecado / !rechazarrecados', () => {
  const handle = (service: BotService, content: string) => service['commands']['handleErrandCommands'](content, 'leon');

  it('no toca otros mensajes', async () => {
    const { service } = await buildBotService();
    expect(await handle(service, 'hola')).toBe(false);
    expect(await handle(service, '!misrecadosss')).toBe(false);
  });

  it('!misrecados lista numerado con vencimiento', async () => {
    const listSent = jest.fn().mockResolvedValue([
      { forUser: 'lyna', text: 'que suba el video', expiresAt: new Date(Date.now() + 2 * 86_400_000 + 60_000) },
    ]);
    const { service, sent } = await buildBotService({ errands: { listSent } as never });
    await handle(service, '!misrecados');
    expect(listSent).toHaveBeenCalledWith('leon');
    expect(sent.join('\n')).toContain('1. Para lyna: "que suba el video" (vence en 2d)');
  });

  it('!misrecados sin pendientes lo dice', async () => {
    const { service, sent } = await buildBotService({ errands: { listSent: jest.fn().mockResolvedValue([]) } as never });
    await handle(service, '!misrecados');
    expect(sent.join(' ')).toContain('No tenés recados pendientes');
  });

  it('!cancelarrecado <n> cancela el propio', async () => {
    const cancelSent = jest.fn().mockResolvedValue({ ok: true, errand: { forUser: 'lyna', text: 'x', expiresAt: new Date() } });
    const { service, sent } = await buildBotService({ errands: { cancelSent } as never });
    await handle(service, '!cancelarrecado 1');
    expect(cancelSent).toHaveBeenCalledWith('leon', 1);
    expect(sent.join(' ')).toContain('Cancelé el recado para lyna');
  });

  it('!cancelarrecado de uno ya entregado avisa', async () => {
    const cancelSent = jest.fn().mockResolvedValue({ ok: false, reason: 'gone' });
    const { service, sent } = await buildBotService({ errands: { cancelSent } as never });
    await handle(service, '!cancelarrecado 1');
    expect(sent.join(' ')).toContain('ya lo entregué');
  });

  it.each(['!cancelarrecado', '!cancelarrecado dos'])('"%s" muestra el uso', async (cmd) => {
    const cancelSent = jest.fn();
    const { service, sent } = await buildBotService({ errands: { cancelSent } as never });
    await handle(service, cmd);
    expect(cancelSent).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Uso: !cancelarrecado');
  });

  it('!rechazarrecados borra los entrantes sin mostrarlos', async () => {
    const rejectIncoming = jest.fn().mockResolvedValue(2);
    const { service, sent } = await buildBotService({ errands: { rejectIncoming } as never });
    await handle(service, '!rechazarrecados');
    expect(rejectIncoming).toHaveBeenCalledWith('leon');
    expect(sent.join(' ')).toContain('Borré 2 recados');
  });

  it('el comando corta antes de la entrega: rechazar no dispara el recado que se rechaza', async () => {
    const claimNext = jest.fn().mockResolvedValue({ fromLabel: 'kei', text: 'secreto' });
    const rejectIncoming = jest.fn().mockResolvedValue(1);
    const { service } = await buildBotService({ errands: { claimNext, rejectIncoming } as never });
    await service['handleNewChatMessage']({ content: '!rechazarrecados', authorUsername: 'leon', authorRole: 'user' } as ChatMessage);
    expect(rejectIncoming).toHaveBeenCalled();
    expect(claimNext).not.toHaveBeenCalled();
  });

  it('si Mongo falla avisa en vez de tirar el proceso', async () => {
    const listSent = jest.fn().mockRejectedValue(new Error('caído'));
    const { service, sent } = await buildBotService({ errands: { listSent } as never });
    await expect(handle(service, '!misrecados')).resolves.toBe(true);
    expect(sent.join(' ')).toContain('No pude leer los recados');
  });
});

describe('el bot como uno más del chat', () => {
  const dejarCorrer = () => new Promise((r) => setImmediate(r));
  const charlaViva = [
    { user: 'kei', message: 'vieron el cap de Frieren?' },
    { user: 'lyna', message: 'sí, lloré' },
    { user: 'kei', message: 'la escena del anillo' },
    { user: 'lyna', message: 'un temazo la música también' },
  ];

  it('guarda en el log lo que respondió, con la mención, para el contexto de sala y el resumen', async () => {
    const { service, logging } = await buildBotService({ chat: { chat: jest.fn().mockResolvedValue('Berserk, sin dudas') } });

    await service['handleNewChatMessage']({ content: 'bot qué leo?', authorUsername: 'kei' } as any);
    await dejarCorrer();

    expect(logging.saveLog).toHaveBeenCalledWith('Aria', '@kei Berserk, sin dudas');
  });

  it('sin que lo nombren, con la charla viva y el dado a favor, comenta sin mención', async () => {
    const proactive = { shouldTry: jest.fn().mockReturnValue(true), markAttempt: jest.fn() };
    const chatProactive = jest.fn().mockResolvedValue('esa escena me rompió también 😭');
    const { service, sent, logging } = await buildBotService({
      proactive,
      chat: { chatProactive },
      logging: { getRecent: jest.fn().mockResolvedValue(charlaViva) },
    });

    await service['handleNewChatMessage']({ content: 'un temazo la música también', authorUsername: 'lyna' } as any);
    await dejarCorrer();
    await dejarCorrer();

    expect(proactive.markAttempt).toHaveBeenCalled();
    expect(chatProactive).toHaveBeenCalledWith('Aria', charlaViva);
    expect(sent).toEqual([expect.stringContaining('esa escena me rompió también')]);
    expect(sent[0]).not.toContain('<@');
    expect(logging.saveLog).toHaveBeenCalledWith('Aria', 'esa escena me rompió también 😭');
  });

  it('si el modelo pasa, no manda nada', async () => {
    const { service, sent } = await buildBotService({
      proactive: { shouldTry: jest.fn().mockReturnValue(true), markAttempt: jest.fn() },
      chat: { chatProactive: jest.fn().mockResolvedValue('') },
      logging: { getRecent: jest.fn().mockResolvedValue(charlaViva) },
    });

    await service['handleNewChatMessage']({ content: 'un temazo la música también', authorUsername: 'lyna' } as any);
    await dejarCorrer();
    await dejarCorrer();

    expect(sent).toEqual([]);
  });

  it('con una charla apagada (una sola persona) ni llama al modelo', async () => {
    const chatProactive = jest.fn();
    const proactive = { shouldTry: jest.fn().mockReturnValue(true), markAttempt: jest.fn() };
    const { service } = await buildBotService({
      proactive,
      chat: { chatProactive },
      logging: { getRecent: jest.fn().mockResolvedValue(charlaViva.map((r) => ({ ...r, user: 'kei' }))) },
    });

    await service['handleNewChatMessage']({ content: 'hablando solo un rato largo', authorUsername: 'kei' } as any);
    await dejarCorrer();
    await dejarCorrer();

    expect(chatProactive).not.toHaveBeenCalled();
    expect(proactive.markAttempt).not.toHaveBeenCalled();
  });
});
