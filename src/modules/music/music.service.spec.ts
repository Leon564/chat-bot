import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MusicService } from './music.service';
import { GraphCacheService } from '../graph/graph-cache.service';
import { GraphService } from '../graph/graph.service';
import { MusicResult, TrackMeta } from '../../common/interfaces';

/**
 * `yt-dlp-wrap` se instancia y se sondea (`--version`, y si falla intenta
 * descargarlo de GitHub) dentro del constructor real de `MusicService`
 * (`initializeYtDlp`, fire-and-forget). Sin este mock, cada test de este
 * archivo dispararía intentos reales de red/proceso al construir el
 * servicio. `exec` lanza sincrónicamente para que `safeYtDlpExec` rechace de
 * inmediato (vía su propio try/catch) en lugar de esperar el timeout.
 */
jest.mock('yt-dlp-wrap', () => {
  const ctor: any = jest.fn().mockImplementation(() => ({
    exec: () => {
      throw new Error('yt-dlp deshabilitado en tests');
    },
  }));
  ctor.downloadFromGithub = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: ctor };
});

/**
 * `music.service.ts` usa el `node-fetch` importado a nivel de módulo (no
 * `globalThis.fetch`) para el HEAD que verifica si una URL cacheada sigue
 * viva — mockear `global.fetch` no alcanzaría, porque el import ya tiene su
 * propia referencia. Se mockea el módulo entero; el resto de los métodos de
 * `MusicService` que también usan `fetch` (upload, connectivity) no se
 * ejercitan en esta suite (el pipeline pesado está siempre doblado vía
 * `enqueueMusicRequest`).
 */
jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));
import fetch from 'node-fetch';

/**
 * `enqueueMusicRequest` es privado — es el punto de entrada al pipeline
 * pesado (búsqueda ytsr, descarga, ffmpeg, subida). Se dobla en todos los
 * tests salvo los de acierto de caché: el brief pide no ejercitar el
 * pipeline real, sólo la decisión de servir desde caché o encolar.
 */
type MusicServiceInterna = {
  enqueueMusicRequest(query: string, username: string): Promise<MusicResult>;
};

/** Deja correr todo lo pendiente en la cola de microtasks (usa un macrotask
 * como frontera) — para no depender del tick exacto en que corre la
 * limpieza del Map de dedup relativa a la promesa que ve el llamador. */
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe('MusicService — caché de pistas y dedup de pedidos en vuelo', () => {
  let service: MusicService;
  let graphCache: { findTrack: jest.Mock; invalidateTrack: jest.Mock };
  let fetchMock: jest.Mock;
  let enqueueSpy: jest.SpyInstance;

  const cachedTrack: TrackMeta = {
    title: 'Canción de Prueba',
    artist: 'Artista de Prueba',
    thumb: 'https://img.example/thumb.jpg',
    youtubeUrl: 'https://youtu.be/abc123',
    uploadUrl: 'https://files.catbox.moe/cached.mp3',
    uploadService: 'catbox',
  };

  /** Resultado "de pipeline": el username va baked en el texto, como lo
   *  arma de verdad `processSingleMusicRequest` con `request.username`. */
  const pipelineResultFor = (username: string): MusicResult => ({
    text: `🎵 <@${username}> Aquí tienes "Mock Song": [audio title="Mock Song"]https://files.catbox.moe/mock.mp3[/audio]`,
    track: {
      title: 'Mock Song',
      artist: 'Mock Artist',
      thumb: null,
      youtubeUrl: 'https://youtu.be/mock',
      uploadUrl: 'https://files.catbox.moe/mock.mp3',
      uploadService: 'catbox',
    },
  });

  beforeEach(async () => {
    graphCache = {
      findTrack: jest.fn(),
      invalidateTrack: jest.fn().mockResolvedValue(undefined),
    };

    fetchMock = fetch as unknown as jest.Mock;
    fetchMock.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        MusicService,
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: GraphCacheService, useValue: graphCache },
        // normalizeKey es una función pura (no toca los modelos de Mongoose)
        // — se usa la clase real para que el test de mayúsculas/acentos
        // ejercite la MISMA normalización que usa el ingest, en vez de
        // reimplementarla en el test.
        { provide: GraphService, useValue: new GraphService({} as any, {} as any) },
      ],
    }).compile();

    service = moduleRef.get<MusicService>(MusicService);

    enqueueSpy = jest
      .spyOn(service as unknown as MusicServiceInterna, 'enqueueMusicRequest')
      .mockImplementation(async (query: string, username: string) => pipelineResultFor(username));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('acierto de caché', () => {
    it('devuelve el BBCode sin encolar (queueLength sigue en 0)', async () => {
      graphCache.findTrack.mockResolvedValue(cachedTrack);
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      await service.processMusic('cancion de prueba', 'alice');

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(service.getQueueStatus()).toEqual({ isProcessing: false, queueLength: 0 });
    });

    it('el texto contiene el título y la URL cacheada', async () => {
      graphCache.findTrack.mockResolvedValue(cachedTrack);
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await service.processMusic('cancion de prueba', 'alice');

      expect(result.text).toContain(cachedTrack.title);
      expect(result.text).toContain(cachedTrack.uploadUrl);
      expect(result.text).toContain('<@alice>');
      expect(result.track).toEqual(cachedTrack);
      // El HEAD se hizo contra la URL cacheada, no cualquier otra, y con un
      // AbortSignal (el timeout de 4s) — no cualquier `fetch` desnudo.
      expect(fetchMock).toHaveBeenCalledWith(
        cachedTrack.uploadUrl,
        expect.objectContaining({ method: 'HEAD', signal: expect.anything() }),
      );
    });
  });

  describe('caché sin servir', () => {
    it('con miss de caché encola normalmente', async () => {
      graphCache.findTrack.mockResolvedValue(null);

      const result = await service.processMusic('otra cancion', 'bob');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).toHaveBeenCalledWith('otra cancion', 'bob');
      expect(result.text).toContain('<@bob>');
      // Sin candidato cacheado no hay nada que verificar con HEAD.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('una URL cacheada que responde 404 se invalida y el pedido se encola', async () => {
      graphCache.findTrack.mockResolvedValue(cachedTrack);
      fetchMock.mockResolvedValue({ ok: false, status: 404 });

      const result = await service.processMusic('cancion de prueba', 'carol');

      expect(graphCache.invalidateTrack).toHaveBeenCalledWith('cancion de prueba');
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(result.text).toContain('<@carol>');
    });

    it('una URL cacheada que responde 410 (Gone) también se invalida y encola', async () => {
      graphCache.findTrack.mockResolvedValue(cachedTrack);
      fetchMock.mockResolvedValue({ ok: false, status: 410 });

      await service.processMusic('cancion de prueba', 'carol');

      expect(graphCache.invalidateTrack).toHaveBeenCalledWith('cancion de prueba');
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it('un HEAD que falla por red (timeout/abort) NO invalida — "no sé" no es "está muerta"', async () => {
      graphCache.findTrack.mockResolvedValue(cachedTrack);
      const abortError = new Error('The user aborted a request.');
      abortError.name = 'AbortError';
      fetchMock.mockRejectedValue(abortError);

      const result = await service.processMusic('cancion de prueba', 'dave');

      expect(graphCache.invalidateTrack).not.toHaveBeenCalled();
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(result.text).toContain('<@dave>');
    });

    it('un HEAD que rechaza por un error de red (ECONNRESET) NO invalida', async () => {
      graphCache.findTrack.mockResolvedValue(cachedTrack);
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      await service.processMusic('cancion de prueba', 'dave');

      expect(graphCache.invalidateTrack).not.toHaveBeenCalled();
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it('un HEAD que responde 403 (CDN que rechaza HEAD) NO invalida — status ambiguo, se sigue al pipeline', async () => {
      graphCache.findTrack.mockResolvedValue(cachedTrack);
      fetchMock.mockResolvedValue({ ok: false, status: 403 });

      const result = await service.processMusic('cancion de prueba', 'frank');

      expect(graphCache.invalidateTrack).not.toHaveBeenCalled();
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(result.text).toContain('<@frank>');
    });

    it('un fallo del propio caché (findTrack rechaza) encola normalmente, sin lanzar', async () => {
      graphCache.findTrack.mockRejectedValue(new Error('mongo caído'));

      const result = await service.processMusic('cancion rara', 'erin');

      expect(result.text).toContain('<@erin>');
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(graphCache.invalidateTrack).not.toHaveBeenCalled();
    });
  });

  describe('dedup de pedidos en vuelo', () => {
    it('dos pedidos idénticos en vuelo se resuelven con un solo procesamiento', async () => {
      graphCache.findTrack.mockResolvedValue(null);

      const [r1, r2] = await Promise.all([
        service.processMusic('cancion compartida', 'alice'),
        service.processMusic('cancion compartida', 'bob'),
      ]);

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(r1.track).toEqual(r2.track);
    });

    it('dos usuarios distintos deduplicados reciben cada uno su propio texto con su nombre', async () => {
      graphCache.findTrack.mockResolvedValue(null);

      const [r1, r2] = await Promise.all([
        service.processMusic('cancion compartida', 'alice'),
        service.processMusic('cancion compartida', 'bob'),
      ]);

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(r1.text).toContain('<@alice>');
      expect(r2.text).toContain('<@bob>');
      expect(r1.text).not.toContain('<@bob>');
      expect(r2.text).not.toContain('<@alice>');
    });

    it('dos pedidos con queries distintas se procesan por separado', async () => {
      graphCache.findTrack.mockResolvedValue(null);

      await Promise.all([
        service.processMusic('cancion uno', 'alice'),
        service.processMusic('cancion dos', 'bob'),
      ]);

      expect(enqueueSpy).toHaveBeenCalledTimes(2);
    });

    it('una query que difiere sólo en mayúsculas o acentos cuenta como la misma', async () => {
      graphCache.findTrack.mockResolvedValue(null);

      await Promise.all([
        service.processMusic('Canción De Amor', 'alice'),
        service.processMusic('cancion de amor', 'bob'),
      ]);

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it('limpia la entrada del map al resolver, permitiendo procesar de nuevo después', async () => {
      graphCache.findTrack.mockResolvedValue(null);

      await service.processMusic('cancion final', 'alice');
      // La limpieza del Map corre en una continuación separada de la que
      // resuelve la promesa que el llamador espera — se deja drenar la cola
      // de microtasks para no depender de en qué tick exacto ocurre cada una.
      await flushMicrotasks();
      await service.processMusic('cancion final', 'alice');

      expect(enqueueSpy).toHaveBeenCalledTimes(2);
    });

    it('limpia la entrada del map también cuando el procesamiento falla, sin cachear el fallo', async () => {
      graphCache.findTrack.mockResolvedValue(null);
      enqueueSpy.mockRejectedValueOnce(new Error('boom'));

      await expect(service.processMusic('cancion con error', 'alice')).rejects.toThrow('boom');
      await flushMicrotasks();

      const result = await service.processMusic('cancion con error', 'bob');

      expect(enqueueSpy).toHaveBeenCalledTimes(2);
      expect(result.text).toContain('<@bob>');
    });
  });
});
