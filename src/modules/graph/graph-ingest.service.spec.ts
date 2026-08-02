import { Test } from '@nestjs/testing';
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
import { GraphIngestService } from './graph-ingest.service';
import { UtilsService } from '../../common/utils/utils.service';
import { ChatMessage } from '../chat-socket/chat-socket.service';

const baseMsg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  _id: 'm1',
  content: 'hola',
  authorUsername: 'Nico',
  type: 'text',
  createdAt: new Date().toISOString(),
  ...over,
});

describe('GraphIngestService — señales sociales', () => {
  let connection: Connection;
  let ingest: GraphIngestService;
  let graph: GraphService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        rootMongooseTestModule(),
        MongooseModule.forFeature([
          { name: GraphNode.name, schema: GraphNodeSchema },
          { name: GraphEdge.name, schema: GraphEdgeSchema },
        ]),
      ],
      providers: [GraphService, GraphIngestService, UtilsService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    ingest = moduleRef.get<GraphIngestService>(GraphIngestService);
    graph = moduleRef.get<GraphService>(GraphService);
    await syncAllIndexes(connection);
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await connection.collection('bot_nodes').deleteMany({});
    await connection.collection('bot_edges').deleteMany({});
  });

  it('crea el nodo del autor con su label original', async () => {
    await ingest.ingestSocial(baseMsg({ authorUsername: 'Sleepy Ash' }));

    const node = await graph.findNode('user', 'sleepy ash');
    expect(node).not.toBeNull();
    expect(node!.label).toBe('Sleepy Ash');
  });

  it('crea aristas interacts_with en ambos sentidos por una mención', async () => {
    await ingest.ingestSocial(baseMsg({ authorUsername: 'Nico', content: 'ey <@kei> mirá esto' }));

    const nico = await graph.findNode('user', 'nico');
    const kei = await graph.findNode('user', 'kei');
    expect(kei).not.toBeNull();

    const ida = await graph.topEdges(nico!._id, ['interacts_with'], 10);
    const vuelta = await graph.topEdges(kei!._id, ['interacts_with'], 10);
    expect(ida[0].label).toBe('kei');
    expect(vuelta[0].label).toBe('Nico');
  });

  it('cuenta varias menciones en un mismo mensaje', async () => {
    await ingest.ingestSocial(baseMsg({ content: '<@kei> y <@Lyna> vengan' }));

    const nico = await graph.findNode('user', 'nico');
    const top = await graph.topEdges(nico!._id, ['interacts_with'], 10);
    expect(top.map((t) => t.label).sort()).toEqual(['Lyna', 'kei']);
  });

  it('refuerza la arista cuando la interacción se repite', async () => {
    await ingest.ingestSocial(baseMsg({ content: '<@kei> hola' }));
    await ingest.ingestSocial(baseMsg({ content: '<@kei> otra vez' }));

    const nico = await graph.findNode('user', 'nico');
    const top = await graph.topEdges(nico!._id, ['interacts_with'], 10);
    expect(top).toHaveLength(1);
    expect(top[0].weight).toBe(2);
  });

  it('cuenta el replyTo como interacción', async () => {
    await ingest.ingestSocial(
      baseMsg({
        content: 'de acuerdo',
        replyTo: { messageId: 'x', authorUsername: 'kei', authorColor: '#fff', contentExcerpt: '...' },
      }),
    );

    const nico = await graph.findNode('user', 'nico');
    const top = await graph.topEdges(nico!._id, ['interacts_with'], 10);
    expect(top[0].label).toBe('kei');
  });

  it('ignora la auto-mención', async () => {
    await ingest.ingestSocial(baseMsg({ authorUsername: 'Nico', content: 'yo <@Nico> soy' }));

    const total = await connection.collection('bot_edges').countDocuments({});
    expect(total).toBe(0);
  });

  it('trata a dos usuarios que difieren en acentos como personas distintas', async () => {
    // El backend los considera cuentas distintas, así que el grafo también
    // debe hacerlo. Antes esta mención se descartaba como auto-mención.
    await ingest.ingestSocial(baseMsg({ authorUsername: 'Jose', content: 'ey <@José> mirá' }));

    const jose = await graph.findNode('user', 'Jose');
    const joseConTilde = await graph.findNode('user', 'José');

    expect(jose).not.toBeNull();
    expect(joseConTilde).not.toBeNull();
    expect(jose!._id.toString()).not.toBe(joseConTilde!._id.toString());

    const aristas = await graph.topEdges(jose!._id, ['interacts_with'], 10);
    expect(aristas.map((a) => a.label)).toContain('José');
  });

  it('sigue descartando la auto-mención real', async () => {
    await ingest.ingestSocial(baseMsg({ authorUsername: 'Nico', content: 'yo <@Nico> soy' }));
    expect(await connection.collection('bot_edges').countDocuments({})).toBe(0);
  });

  it('sigue descartando la auto-mención con distinta capitalización', async () => {
    // El backend es insensible a mayúsculas, así que "NICO" y "Nico" SÍ son
    // la misma persona y esto sí es una auto-mención.
    await ingest.ingestSocial(baseMsg({ authorUsername: 'Nico', content: 'yo <@NICO> soy' }));
    expect(await connection.collection('bot_edges').countDocuments({})).toBe(0);
  });

  it('ignora mensajes de stickers para las menciones', async () => {
    await ingest.ingestSocial(baseMsg({ type: 'sticker', content: '<@kei>' }));

    const total = await connection.collection('bot_edges').countDocuments({});
    expect(total).toBe(0);
  });

  it('no lanza cuando el autor viene vacío', async () => {
    await expect(ingest.ingestSocial(baseMsg({ authorUsername: '' }))).resolves.toBeUndefined();
  });

  it('sanitiza el nombre mencionado antes de persistirlo (revisión final, Important #4)', async () => {
    // `MENTION_RE` acepta cualquier cosa hasta el '>' — sin sanitizar, un
    // token {{...}} incrustado en la mención sobrevivía tal cual en el label
    // del nodo `user`, que alimenta aristas `interacts_with` leídas por
    // `GraphContextService`. Mismo criterio que ya usa `ingestFact` para el
    // objeto de un hecho (`sanitizeMemoryContent`).
    await ingest.ingestSocial(
      baseMsg({ authorUsername: 'Nico', content: 'ey <@kei{{resumen}}> mirá esto' }),
    );

    const node = await graph.findNode('user', 'kei');
    expect(node).not.toBeNull();
    expect(node!.label).toBe('kei');
  });

  describe('ingesta de AniList', () => {
    const result = {
      id: 105398,
      url: 'https://anilist.co/manga/105398',
      kind: 'manhwa' as const,
      titleRomaji: 'Na Honjaman Level Up',
      titleEnglish: 'Solo Leveling',
      coverImage: 'https://img/cover.jpg',
      bannerImage: null,
      score: 84,
      status: 'FINISHED',
      chapters: 179,
      volumes: null,
      episodes: null,
      genres: ['Action', 'Adventure', 'Fantasy'],
      description: 'Un cazador débil...',
      startYear: 2018,
    };

    it('crea el nodo work con key anilist:<id> y la ficha en props', async () => {
      await ingest.ingestAniList('Nico', result, 'solo leveling');

      const node = await graph.findNode('work', 'anilist:105398');
      expect(node).not.toBeNull();
      expect(node!.label).toBe('Solo Leveling');
      expect(node!.props.score).toBe(84);
      expect(node!.props.status).toBe('FINISHED');
      expect(node!.props.chapters).toBe(179);
      expect(node!.props.cachedAt).toBeDefined();
    });

    it('usa titleRomaji como label cuando no hay inglés', async () => {
      await ingest.ingestAniList('Nico', { ...result, titleEnglish: null }, 'x');

      const node = await graph.findNode('work', 'anilist:105398');
      expect(node!.label).toBe('Na Honjaman Level Up');
    });

    it('guarda como alias ambos títulos y la query original', async () => {
      await ingest.ingestAniList('Nico', result, 'el manhwa del cazador débil');

      const node = await graph.findNode('work', 'anilist:105398');
      expect(node!.aliases).toContain('solo leveling');
      expect(node!.aliases).toContain('na honjaman level up');
      expect(node!.aliases).toContain('el manhwa del cazador debil');
    });

    it('crea la arista asked_about desde el usuario', async () => {
      await ingest.ingestAniList('Nico', result, 'x');

      const nico = await graph.findNode('user', 'nico');
      const top = await graph.topEdges(nico!._id, ['asked_about'], 10);
      expect(top[0].label).toBe('Solo Leveling');
    });

    it('crea un nodo genre y una arista has_genre por CADA género', async () => {
      await ingest.ingestAniList('Nico', result, 'x');

      const work = await graph.findNode('work', 'anilist:105398');
      const generos = await graph.topEdges(work!._id, ['has_genre'], 10);
      expect(generos.map((g) => g.label).sort()).toEqual(['Acción', 'Aventura', 'Fantasía']);
    });

    it('deja el género en inglés si no está en el mapa de traducción', async () => {
      await ingest.ingestAniList('Nico', { ...result, genres: ['Isekai'] }, 'x');

      const work = await graph.findNode('work', 'anilist:105398');
      const generos = await graph.topEdges(work!._id, ['has_genre'], 10);
      expect(generos[0].label).toBe('Isekai');
    });

    it('guarda los dos títulos en props, no sólo en el label', async () => {
      await ingest.ingestAniList('Nico', result, 'x');

      const node = await graph.findNode('work', 'anilist:105398');
      expect(node!.props.titleRomaji).toBe('Na Honjaman Level Up');
      expect(node!.props.titleEnglish).toBe('Solo Leveling');
    });

    it('guarda titleEnglish null cuando AniList no lo trae', async () => {
      await ingest.ingestAniList('Nico', { ...result, titleEnglish: null }, 'x');

      const node = await graph.findNode('work', 'anilist:105398');
      expect(node!.props.titleRomaji).toBe('Na Honjaman Level Up');
      expect(node!.props.titleEnglish).toBeNull();
    });

    it('es idempotente: dos consultas no duplican nodos ni aristas', async () => {
      await ingest.ingestAniList('Nico', result, 'solo leveling');
      await ingest.ingestAniList('Nico', result, 'solo leveling');

      const works = await connection.collection('bot_nodes').countDocuments({ type: 'work' });
      const generos = await connection.collection('bot_nodes').countDocuments({ type: 'genre' });
      expect(works).toBe(1);
      expect(generos).toBe(3);

      const nico = await graph.findNode('user', 'nico');
      const top = await graph.topEdges(nico!._id, ['asked_about'], 10);
      expect(top[0].weight).toBe(2);
    });

    describe('refreshCache — el TTL invertido (fix crítico 1)', () => {
      it('por defecto (camino normal) sí escribe/renueva cachedAt', async () => {
        await ingest.ingestAniList('Nico', result, 'x');

        const node = await graph.findNode('work', 'anilist:105398');
        expect(node!.props.cachedAt).toBeDefined();
      });

      it('con refreshCache=false (acierto de caché) NO escribe cachedAt en un nodo nuevo', async () => {
        await ingest.ingestAniList('Nico', result, 'x', { refreshCache: false });

        const node = await graph.findNode('work', 'anilist:105398');
        expect(node).not.toBeNull();
        // El resto de la ingesta (nodo, alias, arista asked_about, géneros)
        // sigue pasando igual — sólo cachedAt queda afuera.
        expect(node!.props.score).toBe(84);
        expect(node!.props.cachedAt).toBeUndefined();
      });

      it('con refreshCache=false NO renueva un cachedAt ya existente (simula un acierto sobre una obra RELEASING vieja)', async () => {
        const hace10dias = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

        // Camino normal: deja un cachedAt "viejo" en el nodo.
        await ingest.ingestAniList('Nico', result, 'x');
        await connection
          .collection('bot_nodes')
          .updateOne({ key: 'anilist:105398' }, { $set: { 'props.cachedAt': hace10dias } });

        // Un acierto de caché sobre esa misma obra sólo debe reforzar
        // asked_about, sin tocar la fecha — si la tocara, una obra RELEASING
        // preguntada cada semana nunca volvería a vencer.
        await ingest.ingestAniList('Nico', result, 'x', { refreshCache: false });

        const node = await graph.findNode('work', 'anilist:105398');
        expect(new Date(node!.props.cachedAt as string | Date).getTime()).toBe(hace10dias.getTime());
      });

      it('el camino normal (refreshCache=true, default) sí renueva un cachedAt viejo', async () => {
        const hace10dias = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

        await ingest.ingestAniList('Nico', result, 'x');
        await connection
          .collection('bot_nodes')
          .updateOne({ key: 'anilist:105398' }, { $set: { 'props.cachedAt': hace10dias } });

        await ingest.ingestAniList('Nico', result, 'x');

        const node = await graph.findNode('work', 'anilist:105398');
        expect(new Date(node!.props.cachedAt as string | Date).getTime()).toBeGreaterThan(hace10dias.getTime());
      });
    });
  });

  describe('ingesta de música', () => {
    const track = {
      title: 'Say It Ain\'t So',
      artist: 'Weezer',
      thumb: 'https://img/t.jpg',
      youtubeUrl: 'https://youtu.be/abc',
      uploadUrl: 'https://files.catbox.moe/x.mp3',
      uploadService: 'catbox',
    };

    it('crea el nodo track con la query normalizada como key', async () => {
      await ingest.ingestTrack('Nico', '  Weezer   Say It Ain\'t So ', track);

      const node = await graph.findNode('track', 'weezer say it ain\'t so');
      expect(node).not.toBeNull();
      expect(node!.label).toBe('Say It Ain\'t So');
      expect(node!.props.uploadUrl).toBe('https://files.catbox.moe/x.mp3');
      expect(node!.props.uploadService).toBe('catbox');
    });

    it('marca catbox como subida permanente', async () => {
      await ingest.ingestTrack('Nico', 'q', track);
      const node = await graph.findNode('track', 'q');
      expect(node!.props.uploadPermanent).toBe(true);
      expect(node!.props.expiresAt).toBeNull();
    });

    it('marca litterbox como subida no permanente', async () => {
      await ingest.ingestTrack('Nico', 'q', { ...track, uploadService: 'litterbox' });
      const node = await graph.findNode('track', 'q');
      expect(node!.props.uploadPermanent).toBe(false);
    });

    it('crea la arista requested del usuario al track', async () => {
      await ingest.ingestTrack('Nico', 'q', track);

      const nico = await graph.findNode('user', 'nico');
      const top = await graph.topEdges(nico!._id, ['requested'], 10);
      expect(top[0].label).toBe('Say It Ain\'t So');
    });

    it('crea el nodo artist y la arista by_artist', async () => {
      await ingest.ingestTrack('Nico', 'q', track);

      const t = await graph.findNode('track', 'q');
      const artistas = await graph.topEdges(t!._id, ['by_artist'], 10);
      expect(artistas[0].label).toBe('Weezer');
    });

    it('no crea nodo artist cuando el artista es null', async () => {
      await ingest.ingestTrack('Nico', 'q', { ...track, artist: null });

      const total = await connection.collection('bot_nodes').countDocuments({ type: 'artist' });
      expect(total).toBe(0);
    });

    it('refuerza la arista cuando la misma canción se pide dos veces', async () => {
      await ingest.ingestTrack('Nico', 'q', track);
      await ingest.ingestTrack('Nico', 'q', track);

      const nico = await graph.findNode('user', 'nico');
      const top = await graph.topEdges(nico!._id, ['requested'], 10);
      expect(top[0].weight).toBe(2);
    });
  });

  describe('ingesta de hechos (SAVE_FACT — Task 4, fase 4b)', () => {
    it('crea la arista likes hacia un nodo topic cuando el objeto no resuelve a nada existente', async () => {
      await ingest.ingestFact('Nico', 'likes', 'Attack on Titan');

      const topic = await graph.findNode('topic', 'attack on titan');
      expect(topic).not.toBeNull();

      const nico = await graph.findNode('user', 'nico');
      const top = await graph.topEdges(nico!._id, ['likes'], 10);
      expect(top).toHaveLength(1);
      expect(top[0].label).toBe('Attack on Titan');
      expect(top[0].nodeType).toBe('topic');
    });

    it('enlaza contra un nodo work existente cuando el objeto resuelve por alias, sin crear un topic aparte', async () => {
      await graph.upsertNode({
        type: 'work',
        key: 'anilist:105398',
        label: 'Solo Leveling',
        aliases: ['solo leveling'],
      });

      await ingest.ingestFact('Nico', 'likes', 'Solo Leveling');

      const nico = await graph.findNode('user', 'nico');
      const top = await graph.topEdges(nico!._id, ['likes'], 10);
      expect(top).toHaveLength(1);
      // La arista apunta al nodo `work` ya existente (identidad por `key`),
      // no a un `topic` nuevo con el mismo label — si resolviera mal, esta
      // aserción pasaría igual con un topic llamado "Solo Leveling"; el
      // conteo de abajo es lo que distingue ambos caminos.
      expect(top[0].key).toBe('anilist:105398');

      const topics = await connection.collection('bot_nodes').countDocuments({ type: 'topic' });
      expect(topics).toBe(0);
    });

    it('acepta dislikes y asked_about, no sólo likes', async () => {
      await ingest.ingestFact('Nico', 'dislikes', 'el ecchi');
      await ingest.ingestFact('Nico', 'asked_about', 'Bleach');

      const nico = await graph.findNode('user', 'nico');
      const dislikes = await graph.topEdges(nico!._id, ['dislikes'], 10);
      const askedAbout = await graph.topEdges(nico!._id, ['asked_about'], 10);
      expect(dislikes).toHaveLength(1);
      expect(dislikes[0].label).toBe('el ecchi');
      expect(askedAbout).toHaveLength(1);
      expect(askedAbout[0].label).toBe('Bleach');
    });

    it('descarta una relación fuera del enum cerrado, sin crear ningún nodo ni arista', async () => {
      await ingest.ingestFact('Nico', 'hates', 'el ecchi');

      // Ni siquiera el nodo `user` se crea: la validación de relación corta
      // antes de tocar el grafo. Si tocara el grafo primero, este conteo
      // sería 1 (el nodo user) aunque la relación inválida se rechazara bien.
      const nodos = await connection.collection('bot_nodes').countDocuments({});
      const aristas = await connection.collection('bot_edges').countDocuments({});
      expect(nodos).toBe(0);
      expect(aristas).toBe(0);
    });

    it('descarta un objeto vacío o de menos de 3 caracteres', async () => {
      await ingest.ingestFact('Nico', 'likes', '');
      await ingest.ingestFact('Nico', 'likes', 'ok');

      const aristas = await connection.collection('bot_edges').countDocuments({ type: 'likes' });
      expect(aristas).toBe(0);
    });

    it('sanitiza el objeto (tokens {{...}}, BBCode, prefijo de color) antes de guardarlo', async () => {
      await ingest.ingestFact(
        'Nico',
        'likes',
        '^#ff0000 [img]http://x/y.png[/img]Attack on Titan {{resumen}}',
      );

      const nico = await graph.findNode('user', 'nico');
      const top = await graph.topEdges(nico!._id, ['likes'], 10);
      expect(top).toHaveLength(1);
      // Si la sanitización no corriera, el label conservaría el prefijo de
      // color, el BBCode o el token — cualquiera de esos sería visible acá.
      expect(top[0].label).toBe('Attack on Titan');
    });

    it('es idempotente: guardar el mismo hecho dos veces sube el peso de la arista a 2, no la duplica', async () => {
      await ingest.ingestFact('Nico', 'likes', 'Attack on Titan');
      await ingest.ingestFact('Nico', 'likes', 'Attack on Titan');

      const nico = await graph.findNode('user', 'nico');
      const top = await graph.topEdges(nico!._id, ['likes'], 10);
      expect(top).toHaveLength(1);
      expect(top[0].weight).toBe(2);
    });

    it('no lanza cuando el grafo falla', async () => {
      jest.spyOn(graph, 'upsertNode').mockRejectedValueOnce(new Error('mongo caído'));

      await expect(
        ingest.ingestFact('Nico', 'likes', 'Attack on Titan'),
      ).resolves.toBeUndefined();

      // La falla ocurrió dentro de touchUser (el primer upsertNode de la
      // llamada) — sin el try/catch, este await hubiera rechazado en vez de
      // resolver undefined.
      const total = await connection.collection('bot_edges').countDocuments({});
      expect(total).toBe(0);
    });

    describe('source de la arista (Task 5, fase 4b — hechos en lote desde el resumen)', () => {
      it('sin el cuarto argumento, persiste la arista con source "fact" (SAVE_FACT en vivo)', async () => {
        await ingest.ingestFact('Nico', 'likes', 'Attack on Titan');

        const edge = await connection.collection('bot_edges').findOne({ type: 'likes' });
        expect(edge?.source).toBe('fact');
      });

      it('con el cuarto argumento "batch", persiste la arista con source "batch", no "fact"', async () => {
        await ingest.ingestFact('Nico', 'likes', 'Attack on Titan', 'batch');

        const edge = await connection.collection('bot_edges').findOne({ type: 'likes' });
        expect(edge?.source).toBe('batch');
      });
    });
  });
});
