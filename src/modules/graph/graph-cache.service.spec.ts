import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import {
  rootMongooseTestModule,
  closeMongoConnection,
  syncAllIndexes,
} from '../../common/testing/mongo-test.helper';
import { GraphNode, GraphNodeSchema } from '../../common/schemas/graph-node.schema';
import { GraphEdge, GraphEdgeSchema } from '../../common/schemas/graph-edge.schema';
import { GraphService } from './graph.service';
import { GraphCacheService, WORK_TTL_DAYS, TRACK_TTL_DAYS } from './graph-cache.service';

/** Props completas, como las dejaría un ingest ya actualizado. */
const propsCompletas = (over: Record<string, unknown> = {}) => ({
  anilistId: 105398,
  kind: 'manhwa',
  url: 'https://anilist.co/manga/105398',
  titleRomaji: 'Na Honjaman Level Up',
  titleEnglish: 'Solo Leveling',
  coverImage: 'https://img/cover.jpg',
  score: 84,
  status: 'FINISHED',
  chapters: 179,
  volumes: null,
  episodes: null,
  startYear: 2018,
  genres: ['Action', 'Fantasy'],
  sinopsisEs: 'Un cazador débil...',
  cachedAt: new Date(),
  ...over,
});

describe('GraphCacheService', () => {
  let connection: Connection;
  let cache: GraphCacheService;
  let graph: GraphService;
  /** Mock de ConfigService — por defecto CACHE_ENABLED=true (comportamiento normal). */
  let configGet: jest.Mock;

  beforeAll(async () => {
    configGet = jest.fn().mockReturnValue(true);

    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([
          { name: GraphNode.name, schema: GraphNodeSchema },
          { name: GraphEdge.name, schema: GraphEdgeSchema },
        ]),
      ],
      providers: [
        GraphService,
        GraphCacheService,
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    cache = moduleRef.get<GraphCacheService>(GraphCacheService);
    graph = moduleRef.get<GraphService>(GraphService);
    await syncAllIndexes(connection);
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  afterEach(() => {
    // Cada test que apaga el caché lo vuelve a prender para no filtrar
    // estado al resto de la suite.
    configGet.mockReturnValue(true);
  });

  beforeEach(async () => {
    await connection.collection('bot_nodes').deleteMany({});
    await connection.collection('bot_edges').deleteMany({});
  });

  const sembrarObra = (props: Record<string, unknown>) =>
    graph.upsertNode({
      type: 'work',
      key: `anilist:${props.anilistId}`,
      label: 'Solo Leveling',
      aliases: ['solo leveling', 'na honjaman level up'],
      props,
    });

  describe('findWork', () => {
    it('devuelve null cuando la obra no está en el grafo', async () => {
      expect(await cache.findWork('manhwa', 'Solo Leveling')).toBeNull();
    });

    it('reconstruye el AniListResult desde props', async () => {
      await sembrarObra(propsCompletas());

      const hit = await cache.findWork('manhwa', 'solo leveling');

      expect(hit).not.toBeNull();
      expect(hit!.result.id).toBe(105398);
      expect(hit!.result.titleRomaji).toBe('Na Honjaman Level Up');
      expect(hit!.result.titleEnglish).toBe('Solo Leveling');
      expect(hit!.result.score).toBe(84);
      expect(hit!.result.chapters).toBe(179);
      expect(hit!.result.genres).toEqual(['Action', 'Fantasy']);
      expect(hit!.sinopsisEs).toBe('Un cazador débil...');
    });

    it('resuelve por cualquiera de los alias', async () => {
      await sembrarObra(propsCompletas());
      expect(await cache.findWork('manhwa', 'Na Honjaman Level Up')).not.toBeNull();
    });

    it('trata como miss un nodo al que le faltan campos de la ficha', async () => {
      // Es el estado de los nodos que escribió la fase 1: sin titleRomaji.
      const { titleRomaji, ...incompletas } = propsCompletas();
      await sembrarObra(incompletas);

      expect(await cache.findWork('manhwa', 'solo leveling')).toBeNull();
    });

    it('devuelve el hit aunque falte la traducción, con sinopsisEs en null', async () => {
      const { sinopsisEs, ...sinTraducir } = propsCompletas();
      await sembrarObra(sinTraducir);

      const hit = await cache.findWork('manhwa', 'solo leveling');
      expect(hit).not.toBeNull();
      expect(hit!.sinopsisEs).toBeNull();
    });

    it('una obra FINISHED no vence nunca', async () => {
      const hace2años = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);
      await sembrarObra(propsCompletas({ status: 'FINISHED', cachedAt: hace2años }));

      expect(await cache.findWork('manhwa', 'solo leveling')).not.toBeNull();
    });

    it('una obra RELEASING vence a los 7 días', async () => {
      const viejo = new Date(Date.now() - (WORK_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
      await sembrarObra(propsCompletas({ status: 'RELEASING', cachedAt: viejo }));

      expect(await cache.findWork('manhwa', 'solo leveling')).toBeNull();
    });

    it('una obra RELEASING reciente sí se sirve', async () => {
      const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await sembrarObra(propsCompletas({ status: 'RELEASING', cachedAt: ayer }));

      expect(await cache.findWork('manhwa', 'solo leveling')).not.toBeNull();
    });

    it('respeta el tipo pedido: no sirve un anime cuando piden manga', async () => {
      await sembrarObra(propsCompletas({ kind: 'anime' }));
      expect(await cache.findWork('manga', 'solo leveling')).toBeNull();
    });

    it('no lanza cuando el grafo falla', async () => {
      jest.spyOn(graph, 'resolveByAliasAndProp').mockRejectedValueOnce(new Error('mongo caído'));
      expect(await cache.findWork('manhwa', 'solo leveling')).toBeNull();
    });

    it('trata como miss un props.kind con casing corrupto, aunque el kind pedido sea válido', async () => {
      await sembrarObra(propsCompletas());
      // Dato corrupto simulado escribiendo directo a la colección — un
      // upsertNode real nunca guardaría esto porque AniListService.kind
      // siempre es uno de los 4 literales en minúscula.
      await connection
        .collection('bot_nodes')
        .updateOne({ key: 'anilist:105398' }, { $set: { 'props.kind': 'MANHWA' } });

      expect(await cache.findWork('manhwa', 'solo leveling')).toBeNull();
    });

    it('una obra duplicada como anime y manhwa resuelve cada una a su propio nodo', async () => {
      // El manhwa es "muy preguntado" (peso alto); el anime, poco. Antes de
      // la corrección, pedir el anime igual resolvía al manhwa (mayor peso)
      // y el mismatch de kind lo volvía un miss permanente.
      await graph.upsertNode({
        type: 'work',
        key: 'anilist:105398',
        label: 'Solo Leveling',
        aliases: ['solo leveling'],
        props: propsCompletas({ anilistId: 105398, kind: 'manhwa' }),
        bumpWeight: true,
      });
      await graph.upsertNode({ type: 'work', key: 'anilist:105398', bumpWeight: true, label: 'Solo Leveling' });
      await graph.upsertNode({ type: 'work', key: 'anilist:105398', bumpWeight: true, label: 'Solo Leveling' });

      await graph.upsertNode({
        type: 'work',
        key: 'anilist:999999',
        label: 'Solo Leveling',
        aliases: ['solo leveling'],
        props: propsCompletas({
          anilistId: 999999,
          kind: 'anime',
          url: 'https://anilist.co/anime/999999',
        }),
      });

      const anime = await cache.findWork('anime', 'solo leveling');
      expect(anime).not.toBeNull();
      expect(anime!.result.kind).toBe('anime');
      expect(anime!.result.id).toBe(999999);

      const manhwa = await cache.findWork('manhwa', 'solo leveling');
      expect(manhwa).not.toBeNull();
      expect(manhwa!.result.kind).toBe('manhwa');
      expect(manhwa!.result.id).toBe(105398);
    });
  });

  describe('findWork — CACHE_ENABLED', () => {
    it('con CACHE_ENABLED=false devuelve null de inmediato, sin consultar el grafo', async () => {
      await sembrarObra(propsCompletas());
      configGet.mockReturnValue(false);

      // `jest.spyOn` sin `mockRestore`/`clearAllMocks` entre tests de este
      // archivo acumula llamadas de tests previos — se compara el conteo
      // antes/después en vez de `.not.toHaveBeenCalled()` para no depender
      // de si el spy venía "limpio".
      const resolveSpy = jest.spyOn(graph, 'resolveByAliasAndProp');
      const llamadasPrevias = resolveSpy.mock.calls.length;

      expect(await cache.findWork('manhwa', 'solo leveling')).toBeNull();
      expect(resolveSpy.mock.calls.length).toBe(llamadasPrevias);
    });
  });

  describe('saveTranslation', () => {
    it('persiste la traducción en el nodo existente', async () => {
      const { sinopsisEs, ...sinTraducir } = propsCompletas();
      await sembrarObra(sinTraducir);

      await cache.saveTranslation(105398, 'Un cazador débil...');

      const hit = await cache.findWork('manhwa', 'solo leveling');
      expect(hit!.sinopsisEs).toBe('Un cazador débil...');
    });

    it('no crea un nodo si la obra no existe', async () => {
      await cache.saveTranslation(999, 'texto');
      expect(await connection.collection('bot_nodes').countDocuments({})).toBe(0);
    });

    it('no lanza cuando el grafo falla', async () => {
      jest.spyOn(graph, 'findNode').mockRejectedValueOnce(new Error('mongo caído'));
      await expect(cache.saveTranslation(105398, 'x')).resolves.toBeUndefined();
    });
  });

  describe('findTrack', () => {
    const sembrarPista = (props: Record<string, unknown> = {}) =>
      graph.upsertNode({
        type: 'track',
        key: 'weezer say it aint so',
        label: 'Say It Ain\'t So',
        props: {
          title: 'Say It Ain\'t So',
          artist: 'Weezer',
          thumb: 'https://img/t.jpg',
          youtubeUrl: 'https://youtu.be/abc',
          uploadUrl: 'https://files.catbox.moe/x.mp3',
          uploadService: 'catbox',
          uploadPermanent: true,
          ...props,
        },
      });

    it('devuelve null cuando la pista no está', async () => {
      expect(await cache.findTrack('weezer say it aint so')).toBeNull();
    });

    it('devuelve la pista cuando la subida es permanente', async () => {
      await sembrarPista();

      const hit = await cache.findTrack('  Weezer   Say It Aint So ');
      expect(hit).not.toBeNull();
      expect(hit!.uploadUrl).toBe('https://files.catbox.moe/x.mp3');
      expect(hit!.artist).toBe('Weezer');
    });

    it('NO sirve una subida no permanente', async () => {
      await sembrarPista({ uploadPermanent: false, uploadService: 'litterbox' });
      expect(await cache.findTrack('weezer say it aint so')).toBeNull();
    });

    it('trata como miss una pista sin uploadUrl', async () => {
      await sembrarPista({ uploadUrl: null });
      expect(await cache.findTrack('weezer say it aint so')).toBeNull();
    });

    it('no lanza cuando el grafo falla', async () => {
      jest.spyOn(graph, 'findNode').mockRejectedValueOnce(new Error('mongo caído'));
      expect(await cache.findTrack('x')).toBeNull();
    });

    it('una pista vigente (recién actualizada) se sirve', async () => {
      await sembrarPista();
      // sembrarPista corre justo antes: `updatedAt` (que Mongoose mantiene
      // solo) queda a segundos de "ahora", muy lejos de TRACK_TTL_DAYS.
      expect(await cache.findTrack('weezer say it aint so')).not.toBeNull();
    });

    it('una pista vencida (más de TRACK_TTL_DAYS sin re-ingestarse) no se sirve', async () => {
      await sembrarPista();
      const vieja = new Date(Date.now() - (TRACK_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
      await connection
        .collection('bot_nodes')
        .updateOne({ type: 'track', key: 'weezer say it aint so' }, { $set: { updatedAt: vieja } });

      expect(await cache.findTrack('weezer say it aint so')).toBeNull();
    });

    it('con CACHE_ENABLED=false devuelve null de inmediato, sin consultar el grafo', async () => {
      await sembrarPista();
      configGet.mockReturnValue(false);

      const findNodeSpy = jest.spyOn(graph, 'findNode');
      const llamadasPrevias = findNodeSpy.mock.calls.length;

      expect(await cache.findTrack('weezer say it aint so')).toBeNull();
      expect(findNodeSpy.mock.calls.length).toBe(llamadasPrevias);
    });
  });

  describe('invalidateTrack', () => {
    it('borra la URL para que el próximo pedido vaya por el pipeline', async () => {
      await graph.upsertNode({
        type: 'track', key: 'q', label: 'T',
        props: { title: 'T', uploadUrl: 'https://muerta', uploadPermanent: true },
      });

      await cache.invalidateTrack('q');

      expect(await cache.findTrack('q')).toBeNull();
      // El nodo sigue existiendo: sólo se invalida la URL.
      expect(await connection.collection('bot_nodes').countDocuments({ type: 'track' })).toBe(1);
    });

    it('no lanza si la pista no existe', async () => {
      await expect(cache.invalidateTrack('no existe')).resolves.toBeUndefined();
    });
  });
});
