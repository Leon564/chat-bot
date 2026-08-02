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
import { GraphService } from '../graph/graph.service';
import { IntentRouterService } from './intent-router.service';

describe('IntentRouterService', () => {
  let connection: Connection;
  let router: IntentRouterService;
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
      providers: [GraphService, IntentRouterService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    graph = moduleRef.get<GraphService>(GraphService);
    router = moduleRef.get<IntentRouterService>(IntentRouterService);
    await syncAllIndexes(connection);
  });

  afterAll(async () => {
    await closeMongoConnection(connection);
  });

  beforeEach(async () => {
    await connection.collection('bot_nodes').deleteMany({});
    await connection.collection('bot_edges').deleteMany({});
    jest.restoreAllMocks();
  });

  const rutear = (msg: string, useMemory = true) => router.route(msg, { useMemory });

  it('siempre incluye PERSONA y TEMPORAL', async () => {
    for (const msg of ['hola', 'bot pon musica', 'cualquier cosa', '']) {
      const bloques = await rutear(msg);
      expect(bloques).toContain('PERSONA');
      expect(bloques).toContain('TEMPORAL');
    }
  });

  describe('ANILIST — el único sin red de seguridad, router permisivo', () => {
    const debenIncluir = [
      'bot qué tal está Berserk?',
      'recomiendame un manhwa',
      'bot info de solo leveling',
      'el anime de demon slayer está bueno?',
      'alguien leyó ese manga de la torre?',
      'bot cuántos capítulos tiene one piece',
      'qué temporada va de jujutsu',
      'me recomiendas algo para leer',
      'bot buscá berserk y vagabond',
      'esta bueno el manhua ese',
      'que estas viendo ahora?',
    ];

    it.each(debenIncluir)('incluye ANILIST para: %s', async (msg) => {
      expect(await rutear(msg)).toContain('ANILIST');
    });

    // Corpus agregado en la revisión final de la fase 3: correr el router
    // contra 28 frases típicas de un chat de anime/manga (grafo vacío) dejó
    // 18 sin cubrir — estas 16 son las que la revisión listó explícitamente
    // (ver ANILIST_QUERY_RE / ANILIST_MEDIA_RE para el detalle de qué
    // patrón cubre cada una).
    const debenIncluirRevisionFinal = [
      'bot que opinas de chainsaw man',
      'bot conoces solo leveling?',
      'bot has visto frieren?',
      'esta buena frieren bot?',
      'bot quien escribio berserk',
      'bot hablame de vagabond',
      'opiniones sobre oshi no ko bot?',
      'bot que onda con chainsaw man',
      'bot deberia empezar solo leveling?',
      'bot dame la ficha de berserk',
      'bot cual es mejor, naruto o bleach',
      'bot me pasas el score de monster',
      'bot como termina attack on titan',
      'bot sabes de kagurabachi?',
      'bot informacion de one piece',
      'bot esta buenaza vinland saga',
    ];

    it.each(debenIncluirRevisionFinal)(
      'incluye ANILIST para (revisión final): %s',
      async (msg) => {
        expect(await rutear(msg)).toContain('ANILIST');
      },
    );

    const noNecesitan = ['hola', 'buenas noches bot', 'jajaja', 'gracias bot'];

    it.each(noNecesitan)('omite ANILIST para: %s', async (msg) => {
      expect(await rutear(msg)).not.toContain('ANILIST');
    });

    // La ampliación de vocabulario de la revisión final no puede arrastrar
    // charla común al bloque ANILIST — estas frases tienen que seguir
    // reduciéndose a sólo PERSONA + TEMPORAL (ninguna otra heurística de
    // ningún bloque debería dispararse tampoco).
    const charlaComun = [
      'jaja si',
      'buen dia gente',
      'que calor hace hoy',
      'ya volvi',
      'alguien vio el partido',
      'hola',
      'gracias bot',
    ];

    it.each(charlaComun)(
      'la charla común sigue devolviendo sólo PERSONA y TEMPORAL: %s',
      async (msg) => {
        expect((await rutear(msg)).sort()).toEqual(['PERSONA', 'TEMPORAL']);
      },
    );
  });

  describe('MUSIC', () => {
    const debenIncluir = [
      'bot reproduce yorushika',
      'pon música de radiohead',
      '!music gods league of legends',
      'quiero escuchar algo tranquilo',
      'ponme esa canción',
      'bot tocá algo',
    ];

    it.each(debenIncluir)('incluye MUSIC para: %s', async (msg) => {
      expect(await rutear(msg)).toContain('MUSIC');
    });

    // El bloque MUSIC del prompt (prompt-builder.service.ts) le enseña al
    // modelo frases como "dale a X" / "ponme X" que el router no reconocía.
    // El daño estaba acotado porque el fast-path de bot.service.ts corta
    // antes de llegar al LLM en la mayoría de los casos, pero el router
    // comparte casi el mismo vocabulario que ese fast-path — así que el
    // conjunto de frases que el fast-path NO atrapa es justo el que
    // necesita el bloque en el prompt, y era el mismo que el router dejaba
    // afuera.
    const debenIncluirRevisionFinal = [
      'bot dale a stairway to heaven',
      'poneme algo',
      'pasame una rola',
      'quiero oir algo',
      'reproduci esa cancion',
      'subi algo de rock',
    ];

    it.each(debenIncluirRevisionFinal)(
      'incluye MUSIC para (revisión final): %s',
      async (msg) => {
        expect(await rutear(msg)).toContain('MUSIC');
      },
    );

    it('omite MUSIC en una charla cualquiera', async () => {
      expect(await rutear('hola cómo va todo')).not.toContain('MUSIC');
    });
  });

  describe('ONLINE', () => {
    const debenIncluir = [
      'quién está en línea?',
      'cuántos hay conectados',
      'bot mostrame los usuarios',
      'quién anda por aquí',
      'who is online',
    ];

    it.each(debenIncluir)('incluye ONLINE para: %s', async (msg) => {
      expect(await rutear(msg)).toContain('ONLINE');
    });

    it('omite ONLINE cuando preguntan por UNA persona', async () => {
      expect(await rutear('está el admin online?')).not.toContain('ONLINE');
    });
  });

  describe('RESUMEN', () => {
    it.each(['bot dame un resumen', 'qué pasó en el chat', 'hacé un recap'])(
      'incluye RESUMEN para: %s',
      async (msg) => {
        expect(await rutear(msg)).toContain('RESUMEN');
      },
    );
  });

  describe('IDENTIDAD', () => {
    it.each([
      'bot quién te creó?',
      'cuáles son las reglas del chat',
      'pasame el discord',
      'quién es tu padre',
    ])('incluye IDENTIDAD para: %s', async (msg) => {
      expect(await rutear(msg)).toContain('IDENTIDAD');
    });

    it('omite IDENTIDAD en una charla cualquiera', async () => {
      expect(await rutear('hola qué tal')).not.toContain('IDENTIDAD');
    });
  });

  describe('SAVE_FACT (Task 4, fase 4b — antes SAVE_MEMORY; la heurística no cambió)', () => {
    it('se incluye cuando el mensaje trae un hecho y useMemory está activo', async () => {
      expect(await rutear('bot me encanta attack on titan')).toContain('SAVE_FACT');
      expect(await rutear('tengo 25 años')).toContain('SAVE_FACT');
    });

    it('nunca se incluye con useMemory desactivado', async () => {
      expect(await rutear('me encanta attack on titan', false)).not.toContain('SAVE_FACT');
    });

    it('se omite en un saludo simple', async () => {
      expect(await rutear('hola')).not.toContain('SAVE_FACT');
    });
  });

  describe('saludo simple — el caso que más ahorra', () => {
    it.each(['hola', 'hey bot', 'buenas', 'qué tal'])(
      'para "%s" sólo deja PERSONA y TEMPORAL',
      async (msg) => {
        expect((await rutear(msg)).sort()).toEqual(['PERSONA', 'TEMPORAL']);
      },
    );
  });

  describe('isSimpleGreeting — única fuente compartida con chat.service.ts', () => {
    // Antes `chat.service.ts` sostenía su propia regex de saludo, más
    // angosta (sin "<saludo> bot", sin des-acentuar el mensaje, sin
    // puntuación repetida): "hey bot" era saludo para el router pero NO
    // para `chat.service.ts`; "qué tal" (con tilde) y "hola!!" tampoco.
    // Ahora `chat.service.ts` llama a `router.isSimpleGreeting`, así que
    // ambos lados usan siempre el mismo resultado.
    const divergian = ['hey bot', 'qué tal', 'hola!!'];

    it.each(divergian)('isSimpleGreeting("%s") es true', (msg) => {
      expect(router.isSimpleGreeting(msg)).toBe(true);
    });

    it.each(divergian)('route() también lo recorta a PERSONA+TEMPORAL: %s', async (msg) => {
      expect((await rutear(msg)).sort()).toEqual(['PERSONA', 'TEMPORAL']);
    });
  });

  it('nunca devuelve un bloque repetido', async () => {
    const bloques = await rutear('bot pon música de berserk y decime quién está online');
    expect(new Set(bloques).size).toBe(bloques.length);
  });

  describe('ANILIST por alias del grafo', () => {
    it('reconoce un título que ya está en el grafo, sin vocabulario de media', async () => {
      await graph.upsertNode({
        type: 'work', key: 'anilist:85143', label: 'Tower of God',
        aliases: ['tower of god', 'el manhwa de la torre'],
      });

      // Sin la palabra manga/manhwa/anime en ningún lado.
      expect(await rutear('alguien sigue tower of god?')).toContain('ANILIST');
      expect(await rutear('que onda el manhwa de la torre')).toContain('ANILIST');
    });

    it('no confunde una palabra suelta con un título', async () => {
      await graph.upsertNode({ type: 'work', key: 'anilist:1', label: 'Monster', aliases: ['monster'] });

      // "monster" aparece pero no como referencia a la obra. El router es
      // permisivo, asi que incluir ANILIST aca es aceptable; lo que NO puede
      // pasar es que rompa el resto del ruteo.
      const bloques = await rutear('ese bicho es un monster jaja');
      expect(bloques).toContain('PERSONA');
    });

    it('reconoce una obra que el usuario consultó hace poco', async () => {
      const user = await graph.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      const work = await graph.upsertNode({ type: 'work', key: 'anilist:2', label: 'Berserk' });
      await graph.upsertEdge({ from: user!._id, to: work!._id, type: 'asked_about', source: 'signal' });

      // Pregunta de seguimiento, sin nombrar la obra ni vocabulario de media.
      expect(await router.route('y el segundo?', { useMemory: true, username: 'Nico' }))
        .toContain('ANILIST');
    });

    it('usa la arista más RECIENTE, no la de mayor peso, para detectar hilo activo', async () => {
      // Escenario exacto de la revisión final: un usuario que preguntó 5
      // veces por One Piece hace una semana (arista pesada, vieja) y 1 vez
      // por Frieren hace unos segundos (arista liviana, reciente). Con
      // `hasRecentWorkThread` basado en `topEdges` (ordena por weight) esto
      // devolvía la arista de One Piece — fuera de la ventana de 10 min —
      // y el bloque se omitía. Con `recentEdges` (ordena por lastSeenAt) se
      // detecta correctamente el hilo reciente de Frieren.
      const user = await graph.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      const heavy = await graph.upsertNode({ type: 'work', key: 'anilist:1', label: 'One Piece' });
      const light = await graph.upsertNode({ type: 'work', key: 'anilist:2', label: 'Frieren' });

      for (let i = 0; i < 5; i++) {
        await graph.upsertEdge({ from: user!._id, to: heavy!._id, type: 'asked_about', source: 'signal' });
      }
      await connection.collection('bot_edges').updateOne(
        { from: user!._id, to: heavy!._id, type: 'asked_about' },
        { $set: { lastSeenAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      );

      // `upsertEdge` fija lastSeenAt a "ahora" — dentro de la ventana de 10 min.
      await graph.upsertEdge({ from: user!._id, to: light!._id, type: 'asked_about', source: 'signal' });

      expect(await router.route('y el segundo?', { useMemory: true, username: 'Nico' }))
        .toContain('ANILIST');
    });

    it('no incluye ANILIST si la arista es vieja (fuera de la ventana de 10 min)', async () => {
      const user = await graph.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      const work = await graph.upsertNode({ type: 'work', key: 'anilist:2', label: 'Berserk' });
      await graph.upsertEdge({ from: user!._id, to: work!._id, type: 'asked_about', source: 'signal' });

      // upsertEdge siempre fija lastSeenAt a "ahora" — lo retrasamos a mano
      // para simular una arista que quedó fuera de la ventana de 10 min.
      await connection.collection('bot_edges').updateOne(
        { from: user!._id, to: work!._id, type: 'asked_about' },
        { $set: { lastSeenAt: new Date(Date.now() - 11 * 60 * 1000) } },
      );

      expect(await router.route('y el segundo?', { useMemory: true, username: 'Nico' }))
        .not.toContain('ANILIST');
    });

    it('no aplica el hilo reciente a otro usuario', async () => {
      const user = await graph.upsertNode({ type: 'user', key: 'nico', label: 'Nico' });
      const work = await graph.upsertNode({ type: 'work', key: 'anilist:2', label: 'Berserk' });
      await graph.upsertEdge({ from: user!._id, to: work!._id, type: 'asked_about', source: 'signal' });
      // `kei` existe como nodo propio, sin aristas — si `hasRecentWorkThread`
      // tuviera un bug que ignora el `_id` del usuario (p. ej. usa el primer
      // nodo `user` que encuentra) este test lo detecta; con `kei`
      // inexistente el corte llegaría antes, por `findNode` devolviendo null,
      // y no probaría nada sobre el uso del `_id`.
      await graph.upsertNode({ type: 'user', key: 'kei', label: 'Kei' });

      expect(await router.route('y el segundo?', { useMemory: true, username: 'kei' }))
        .not.toContain('ANILIST');
    });

    it('conserva la puntuación interna del alias (no lo confunde con separador de palabras)', async () => {
      await graph.upsertNode({
        type: 'work', key: 'anilist:50', label: "JoJo's Bizarre Adventure",
        aliases: ["jojo's bizarre adventure"],
      });

      // "conoces" no dispara ninguna heurística de vocabulario (a diferencia
      // de "viste", que sí matchea ANILIST_QUERY_RE) — la única vía posible
      // hacia ANILIST acá es el alias del grafo. El apóstrofe es interno a
      // "jojo's": si el candidato lo reemplazara por un espacio ("jojo s
      // bizarre adventure") nunca matchearía el alias guardado.
      expect(await rutear("conoces jojo's bizarre adventure?")).toContain('ANILIST');
    });

    it('reconoce un título de una sola palabra, sin vocabulario de media', async () => {
      await graph.upsertNode({ type: 'work', key: 'anilist:3', label: 'Berserk', aliases: ['berserk'] });

      // La mayoría de los títulos de anime/manga son una sola palabra — este
      // es justo el caso que la condición 1 (unigramas) existe para cubrir.
      // "sigue" no dispara ninguna heurística de vocabulario.
      expect(await rutear('alguien sigue berserk?')).toContain('ANILIST');
    });

    it('un unigrama de una palabra vacía no dispara ANILIST por el grafo', async () => {
      // Alias absurdo a propósito: "que" es una stopword del filtro de
      // unigramas (ver GRAPH_STOPWORDS), así que aunque el nodo exista no
      // debería convertirse en candidato.
      await graph.upsertNode({ type: 'work', key: 'anilist:98', label: 'Que (nodo de prueba)', aliases: ['que'] });

      // Mensaje normal que contiene "que" pero no dispara ninguna otra
      // heurística de vocabulario.
      expect(await rutear('no se que onda hoy')).not.toContain('ANILIST');
    });

    it('separa por coma y punto y coma al generar candidatos (preserva apóstrofos y dos puntos)', async () => {
      await graph.upsertNode({ type: 'work', key: 'anilist:70', label: 'Bleach', aliases: ['bleach'] });

      // Mensaje elegido para que la ÚNICA vía hacia ANILIST sea el alias
      // del grafo: ninguna palabra dispara ANILIST_MEDIA_RE/ANILIST_QUERY_RE.
      // Sin la coma actuando como separador, "naruto,bleach" queda pegado
      // como un solo candidato que nunca matchea el alias "bleach" guardado
      // por separado.
      //
      // (La frase del hallazgo original, "bot cual es mejor, naruto o
      // bleach", ya dispara ANILIST por vocabulario — ver "mejor" en el
      // corpus de ANILIST más arriba — así que no aislaría este fix.)
      expect(await rutear('che fijate naruto,bleach porfa')).toContain('ANILIST');
    });

    it('reconoce un alias de una sola palabra con puntuación interna', async () => {
      await graph.upsertNode({ type: 'work', key: 'anilist:60', label: 'Re:Zero', aliases: ['re:zero'] });

      // Antes de bajar el mínimo de n-gramas a 1, un título de una sola
      // palabra con puntuación interna (ni siquiera se generaba como
      // candidato de 2+ palabras) quedaba fuera de alcance por completo.
      expect(await rutear('alguien vio re:zero?')).toContain('ANILIST');
    });

    it('no se rompe cuando el grafo falla', async () => {
      // "bot qué tal está Berserk?" NO sirve para este test: matchea
      // ANILIST_QUERY_RE ("que tal esta") y el `||` corta antes de llegar al
      // grafo, así que el spy nunca se ejecuta y el test queda vacuo. Acá
      // usamos un mensaje sin ningún vocabulario de media/consulta, para que
      // la única vía posible hacia ANILIST sea el grafo.
      const spy = jest
        .spyOn(graph, 'resolveAnyAlias')
        .mockRejectedValueOnce(new Error('mongo caído'));

      const bloques = await rutear('y el segundo?');

      expect(spy).toHaveBeenCalled();
      expect(bloques).toContain('PERSONA');
      expect(bloques).toContain('TEMPORAL');
      // Éste es el único camino de degradación crítico de la fase: si el
      // grafo falla, ANILIST debe quedar afuera (no hay vocabulario ni alias
      // que lo respalde en este mensaje). Antes el test no lo aseveraba.
      expect(bloques).not.toContain('ANILIST');
    });
  });
});
