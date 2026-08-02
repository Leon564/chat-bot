import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import {
  rootMongooseTestModule,
  closeMongoConnection,
  syncAllIndexes,
} from '../../common/testing/mongo-test.helper';
import { GraphNode, GraphNodeSchema } from '../../common/schemas/graph-node.schema';
import { GraphEdge, GraphEdgeSchema } from '../../common/schemas/graph-edge.schema';
import { GraphService } from './graph.service';
import {
  GraphContextService,
  MAX_EDGES,
  MAX_CHARS,
  LAST_NODE_WINDOW_MS,
  RETURNING_AFTER_DAYS,
} from './graph-context.service';
import { MIN_CANDIDATES } from './graph.service';

describe('GraphContextService', () => {
  let connection: Connection;
  let service: GraphContextService;
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
      providers: [GraphService, GraphContextService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    service = moduleRef.get<GraphContextService>(GraphContextService);
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

  const sembrarGusto = async (user: string, obra: string, veces = 1) => {
    const u = await graph.upsertNode({ type: 'user', key: user, label: user });
    const w = await graph.upsertNode({ type: 'work', key: obra, label: obra, aliases: [obra] });
    for (let i = 0; i < veces; i++) {
      await graph.upsertEdge({ from: u!._id, to: w!._id, type: 'likes', source: 'fact' });
    }
    return { u: u!, w: w! };
  };

  /** Escribe `props.lastNode` directamente, como haría `GraphIngestService.touchLastNode`. */
  const sembrarLastNode = async (user: string, label: string, at: Date = new Date()) => {
    return graph.upsertNode({
      type: 'user',
      key: user,
      label: user,
      props: { lastNode: { key: `work:${label}`, type: 'work', label, at } },
    });
  };

  /** Escribe `props.previousMessageAt` directamente, como haría `GraphIngestService.touchUser`. */
  const sembrarPreviousMessageAt = async (user: string, at: Date) => {
    return graph.upsertNode({
      type: 'user',
      key: user,
      label: user,
      props: { previousMessageAt: at },
    });
  };

  const haceDias = (dias: number) => new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

  it('devuelve cadena vacía para un usuario sin nada en el grafo', async () => {
    expect(await service.build('Nico', 'hola')).toBe('');
  });

  it('devuelve cadena vacía si el username viene vacío', async () => {
    await sembrarGusto('Nico', 'Berserk');
    expect(await service.build('', 'hola')).toBe('');
  });

  it('menciona lo que le gusta al usuario', async () => {
    await sembrarGusto('Nico', 'Berserk');

    const linea = await service.build('Nico', 'hola');

    expect(linea).toContain('Nico');
    expect(linea).toContain('Berserk');
  });

  it('NO menciona lo que le gusta a otro usuario', async () => {
    await sembrarGusto('kei', 'Vagabond');
    await sembrarGusto('Nico', 'Berserk');

    const linea = await service.build('Nico', 'hola');

    expect(linea).toContain('Berserk');
    expect(linea).not.toContain('Vagabond');
  });

  it('ordena por peso: lo más reforzado primero', async () => {
    await sembrarGusto('Nico', 'Poco', 1);
    await sembrarGusto('Nico', 'Mucho', 5);

    const linea = await service.build('Nico', 'hola');

    expect(linea.indexOf('Mucho')).toBeLessThan(linea.indexOf('Poco'));
  });

  it('distingue lo que le gusta de lo que ya se le recomendó — por estructura, no sólo presencia', async () => {
    const { u } = await sembrarGusto('Nico', 'Berserk');
    const rec = await graph.upsertNode({ type: 'work', key: 'ORV', label: 'ORV' });
    await graph.upsertEdge({ from: u._id, to: rec!._id, type: 'recommended_to', source: 'signal' });

    const linea = await service.build('Nico', 'hola');
    const lower = linea.toLowerCase();

    const gustaIdx = lower.indexOf('gusta');
    const recomendIdx = lower.indexOf('recomend');
    const berserkIdx = lower.indexOf('berserk');
    const orvIdx = lower.indexOf('orv');

    expect(gustaIdx).toBeGreaterThanOrEqual(0);
    expect(recomendIdx).toBeGreaterThan(gustaIdx);

    // Berserk cuelga de la sección "le gusta": aparece entre su marcador y el
    // de recomendaciones, nunca después.
    expect(berserkIdx).toBeGreaterThan(gustaIdx);
    expect(berserkIdx).toBeLessThan(recomendIdx);

    // ORV cuelga de la sección de recomendaciones. Esta aserción es la que
    // detectaría un bug que junta todo en un solo balde (p. ej. renderizar
    // "ya le recomendé ORV, Berserk"): ahí Berserk reaparecería después del
    // marcador de recomendaciones, y esta línea fallaría.
    expect(orvIdx).toBeGreaterThan(recomendIdx);
    expect(lower.slice(recomendIdx)).not.toContain('berserk');
  });

  describe('lastNode — continuidad conversacional (Fase 5b, Task 2)', () => {
    it('menciona lo último que miró el usuario, señalándolo como tal', async () => {
      await sembrarLastNode('Nico', 'Berserk');

      const linea = await service.build('Nico', 'hola');

      expect(linea).toMatch(/lo último que miró fue Berserk/i);
    });

    it('si no hay lastNode, la línea no inventa nada ni deja texto suelto', async () => {
      await sembrarGusto('Nico', 'Berserk');

      const linea = await service.build('Nico', 'hola');

      // Comparación exacta, no sólo `not.toContain`: prueba que no se coló
      // ningún conector o fragmento extra (p. ej. "; lo último que miró fue")
      // cuando no hay lastNode que mostrar.
      expect(linea).toBe('Sobre Nico: le gusta Berserk.');
    });

    it('un lastNode de hace más de 30 minutos no se menciona (dejó de ser "lo último")', async () => {
      const haceRato = new Date(Date.now() - (LAST_NODE_WINDOW_MS + 60_000));
      await sembrarLastNode('Nico', 'Berserk', haceRato);
      await sembrarGusto('Nico', 'Vinland Saga');

      const linea = await service.build('Nico', 'hola');

      expect(linea).toContain('Vinland Saga');
      expect(linea).not.toMatch(/último que miró/i);
      expect(linea).not.toContain('Berserk');
    });

    it('un lastNode de hace menos de 30 minutos sí se menciona (control positivo de la ventana)', async () => {
      const haceUnRato = new Date(Date.now() - (LAST_NODE_WINDOW_MS - 60_000));
      await sembrarLastNode('Nico', 'Berserk', haceUnRato);

      const linea = await service.build('Nico', 'hola');

      expect(linea).toMatch(/último que miró fue Berserk/i);
    });

    it('el lastNode del usuario A no aparece en la línea del usuario B', async () => {
      await sembrarLastNode('kei', 'Vagabond');
      await sembrarGusto('Nico', 'Berserk');

      const linea = await service.build('Nico', 'hola');

      expect(linea).toContain('Berserk');
      expect(linea).not.toContain('Vagabond');
    });
  });

  it('destaca la obra que la pregunta menciona, si el usuario tiene relación con ella', async () => {
    await sembrarGusto('Nico', 'Berserk');
    await sembrarGusto('Nico', 'Vinland Saga');

    const linea = await service.build('Nico', 'bot qué opinás de berserk?');

    // No alcanza con que "Berserk" esté en algún lado (ya está entre los
    // gustos) ni con que exista ALGÚN resaltado: hay que atar el resaltado
    // al label concreto que se preguntó.
    expect(linea).toMatch(/preguntó por berserk/i);

    // Caso negativo: si `resolveHighlight` matcheara el nodo equivocado,
    // el resaltado señalaría la otra obra que el usuario también tiene entre
    // sus gustos — esta aserción lo detectaría.
    const resaltado = linea.match(/preguntó por ([^.;]+)/i);
    expect(resaltado).not.toBeNull();
    expect(resaltado![1].toLowerCase()).not.toContain('vinland');
  });

  it('resalta una obra cuya clave difiere de su etiqueta (formato real de AniList)', async () => {
    // `GraphIngestService.ingestAniList` persiste los nodos `work` con
    // `key = 'anilist:<id>'` y `label` = título mostrable — distintos a
    // propósito. Comparar por `label` normalizado (en vez de por `key`, la
    // identidad real del nodo) fallaría en silencio para TODAS las obras
    // ingresadas desde AniList, que es el origen real de estos nodos en
    // producción — no simplificar este fixture a `key === label` como el
    // resto de los tests de este archivo, porque eso reabre exactamente el
    // agujero que este test existe para cerrar.
    const u = await graph.upsertNode({ type: 'user', key: 'Nico', label: 'Nico' });
    const w = await graph.upsertNode({
      type: 'work',
      key: 'anilist:105398',
      label: 'Solo Leveling',
      aliases: ['solo leveling'],
    });
    await graph.upsertEdge({ from: u!._id, to: w!._id, type: 'likes', source: 'fact' });

    const linea = await service.build('Nico', 'bot que onda con solo leveling?');

    expect(linea).toMatch(/preguntó por solo leveling/i);
  });

  it('respeta el tope de caracteres', async () => {
    for (let i = 0; i < 40; i++) {
      await sembrarGusto('Nico', `Obra con un titulo bastante largo numero ${i}`, i + 1);
    }

    const linea = await service.build('Nico', 'hola');

    expect(linea.length).toBeLessThanOrEqual(MAX_CHARS);
  });

  it('trunca en un límite de palabra completo cuando una sola arista ya supera el tope', async () => {
    // Con MAX_EDGES=6 acotando la consulta, 40 obras cortas nunca fuerzan la
    // rama de recorte de `truncate()` (ver reporte de la ronda anterior).
    // Este test siembra UNA sola arista cuyo label ya es más largo que
    // MAX_CHARS por sí solo, para forzar el recorte de forma determinística.
    const tituloLargo = Array.from({ length: 60 }, (_, i) => `palabra${i}`).join(' ');
    await sembrarGusto('Nico', tituloLargo);

    const linea = await service.build('Nico', 'hola');
    const sinTruncar = `Sobre Nico: le gusta ${tituloLargo}.`;

    // Realmente entró a la rama de truncado, no es casualidad que ya calzara.
    expect(sinTruncar.length).toBeGreaterThan(MAX_CHARS);
    expect(linea.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(linea.length).toBeLessThan(sinTruncar.length);

    // El corte cae en un límite de palabra completo: el último token no es
    // una palabra partida a mitad de camino.
    const ultimoToken = linea.trim().split(' ').pop()!;
    expect(ultimoToken).toMatch(/^palabra\d+$/);
  });

  it('si el recorte cae justo en el verbo de "lo último que miró", no lo deja colgando sin objeto', async () => {
    // Una sola palabra sin espacios de sobra: el único espacio disponible
    // para el recorte por límite de palabra es el que separa "fue" del
    // label, así que el corte cae justo ahí — el caso que el guard de
    // `truncate()` existe para evitar.
    const labelGigante = 'x'.repeat(400);
    await sembrarLastNode('Nico', labelGigante);

    const linea = await service.build('Nico', 'hola');

    expect(linea.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(linea.endsWith('fue')).toBe(false);
    expect(linea).not.toMatch(/miró fue$/);
  });

  it('el recorte NUNCA deja un fragmento de un título real cruzando el límite (B3, ronda de corrección final)', async () => {
    // Medido sobre la línea cargada real (hallazgo B3 de la revisión final):
    // "Shingeki no Kyojin:" es una obra DISTINTA de "Shingeki no Kyojin: The
    // Final Season". El guard de DANGLING_SUFFIXES sólo cubre el verbo
    // colgando sin objeto -- no cubre que el recorte por límite de palabra
    // caiga a mitad de un label real con espacios internos, dejando un
    // prefijo que además resulta ser el nombre de otra obra real.
    const target = 'Shingeki no Kyojin: The Final Season';
    const prefix = 'Sobre Nico: le gusta ';

    // Se arma el relleno para que el corte de MAX_CHARS caiga
    // determinísticamente en el espacio que separa "Kyojin:" del resto del
    // título real -- reproduce el caso medido, no uno construido a mano con
    // números fijos que se desincronizarían si MAX_CHARS cambia.
    const cutIndexInTarget = target.indexOf(': ') + 1; // el espacio justo después de "Kyojin:"
    const totalBeforeTarget = MAX_CHARS - cutIndexInTarget - 1;
    const fillerLen = totalBeforeTarget - prefix.length - ', '.length;
    const filler = 'r'.repeat(fillerLen);

    // El relleno pesa más que el título real -- así queda ANTES en la
    // lista (topEdges ordena por peso descendente) y el título real, al
    // final, es lo que efectivamente cruza el límite de MAX_CHARS.
    await sembrarGusto('Nico', filler, 2);
    await sembrarGusto('Nico', target, 1);

    const linea = await service.build('Nico', 'hola');
    const sinTruncar = `${prefix}${filler}, ${target}.`;

    // Realmente entró a la rama de truncado, no es casualidad que ya calzara.
    expect(sinTruncar.length).toBeGreaterThan(MAX_CHARS);
    expect(linea.length).toBeLessThanOrEqual(MAX_CHARS);

    // El defecto exacto medido en la revisión: el resultado terminaba en
    // "Shingeki no Kyojin:", el prefijo que además es otra obra real.
    expect(linea.endsWith('Kyojin:')).toBe(false);
  });

  it('no descarta un ítem completo cuando el corte por palabra ya cae en su borde (M1, ronda corta)', async () => {
    // item0 e item1 son ítems cortos y completos, sin espacios internos;
    // item2 es un solo token larguísimo (también sin espacios) que por sí
    // solo cruza MAX_CHARS -- para forzar la rama de truncado de forma
    // determinística, igual que el test de arriba. La diferencia clave: acá
    // el corte por límite de palabra cae justo en el espacio que sigue a la
    // coma de item1 -- un borde de ítem REAL, no a mitad de un label -- así
    // que ni item0 ni item1 deberían perderse. El guard vigente mira lo que
    // sigue DESPUÉS del corte (el arranque de item2, que nunca es puntuación)
    // en vez de mirar que `trimmed` ya termina en coma, así que retrocede de
    // más y descarta item1 igual.
    const item0 = 'PrimeraObra';
    const item1 = 'SegundaObra';
    const prefix = 'Sobre Nico: le gusta ';
    const itemLargo = 'Z'.repeat(MAX_CHARS);

    await sembrarGusto('Nico', item0, 3);
    await sembrarGusto('Nico', item1, 2);
    await sembrarGusto('Nico', itemLargo, 1);

    const linea = await service.build('Nico', 'hola');
    const sinTruncar = `${prefix}${item0}, ${item1}, ${itemLargo}.`;

    // Realmente entró a la rama de truncado, no es casualidad que ya calzara.
    expect(sinTruncar.length).toBeGreaterThan(MAX_CHARS);
    expect(linea.length).toBeLessThanOrEqual(MAX_CHARS);

    expect(linea).toContain(item0);
    // El ítem completo que el guard actual descarta de más: ya estaba
    // entero antes del corte, en un borde de ítem real.
    expect(linea).toContain(item1);
  });

  it('no incluye más de MAX_EDGES relaciones', async () => {
    for (let i = 0; i < 20; i++) await sembrarGusto('Nico', `Obra${i}`, i + 1);

    const linea = await service.build('Nico', 'hola');
    // OJO: `linea.includes('Obra1')` daría falso positivo con "Obra14",
    // "Obra15" ... "Obra19" (substring), inflando el conteo aunque la
    // implementación respete MAX_EDGES. El lookahead exige que no siga otro
    // dígito, para contar "Obra1" sólo cuando es exactamente esa obra.
    const mencionadas = Array.from({ length: 20 }, (_, i) => `Obra${i}`)
      .filter((o) => new RegExp(`${o}(?!\\d)`).test(linea));

    expect(mencionadas.length).toBeLessThanOrEqual(MAX_EDGES);
  });

  describe('candidatas de recomendación colaborativa (Task 3, fase 5b)', () => {
    /** Suma `n` candidatas distintas que `otro` (ya con un gusto compartido con `sujeto`) también le gustan. */
    const sembrarCandidatas = async (otro: { _id: Types.ObjectId }, n: number) => {
      for (let i = 0; i < n; i++) {
        const w = await graph.upsertNode({ type: 'work', key: `candidata${i}`, label: `Candidata ${i}` });
        await graph.upsertEdge({ from: otro._id, to: w!._id, type: 'likes', source: 'fact' });
      }
    };

    it('con >= MIN_CANDIDATES, la línea las menciona señalándolas como sugerencias de la comunidad', async () => {
      await sembrarGusto('Nico', 'Berserk');
      const { u: kei } = await sembrarGusto('kei', 'Berserk');
      await sembrarCandidatas(kei, MIN_CANDIDATES);

      const linea = await service.build('Nico', 'hola');

      // Señaladas como algo que le gustó a OTROS, no como un gusto propio de
      // Nico -- de lo contrario el modelo las confundiría con una preferencia
      // ya confirmada.
      expect(linea).toMatch(/gustos parecidos/i);
      for (let i = 0; i < MIN_CANDIDATES; i++) {
        expect(linea).toContain(`Candidata ${i}`);
      }
    });

    it('con menos de MIN_CANDIDATES, la línea no las menciona en absoluto', async () => {
      await sembrarGusto('Nico', 'Berserk');
      const { u: kei } = await sembrarGusto('kei', 'Berserk');
      await sembrarCandidatas(kei, MIN_CANDIDATES - 1);

      const linea = await service.build('Nico', 'hola');

      // Por debajo del umbral, ni la etiqueta de la sección ni ninguna
      // candidata puntual aparecen -- "le gustó a alguien más" apoyado en
      // una sola coincidencia no es una señal de comunidad real.
      expect(linea).not.toMatch(/gustos parecidos/i);
      for (let i = 0; i < MIN_CANDIDATES - 1; i++) {
        expect(linea).not.toContain(`Candidata ${i}`);
      }
    });
  });

  it('devuelve cadena vacía cuando el grafo falla, sin lanzar', async () => {
    await sembrarGusto('Nico', 'Berserk');
    jest.spyOn(graph, 'findNode').mockRejectedValueOnce(new Error('mongo caído'));

    expect(await service.build('Nico', 'hola')).toBe('');
  });

  describe('nota de regreso — previousMessageAt (Task 4, fase 5b)', () => {
    it('un usuario cuyo previousMessageAt es de hace más de RETURNING_AFTER_DAYS recibe la nota de regreso', async () => {
      await sembrarGusto('Nico', 'Berserk');
      await sembrarPreviousMessageAt('Nico', haceDias(RETURNING_AFTER_DAYS + 6));

      const linea = await service.build('Nico', 'hola');

      expect(linea).toMatch(/vuelve después de \d+ días sin escribir/i);
    });

    it('uno que habló ayer NO la recibe', async () => {
      await sembrarGusto('Nico', 'Berserk');
      await sembrarPreviousMessageAt('Nico', haceDias(1));

      const linea = await service.build('Nico', 'hola');

      // Si la condición de días estuviera invertida (p. ej. "< " en vez de
      // "> RETURNING_AFTER_DAYS"), este caso -que está del lado equivocado
      // del umbral- dispararía la nota igual, y esta aserción lo detectaría.
      expect(linea).not.toMatch(/vuelve después de/i);
    });

    it('exactamente en el umbral (RETURNING_AFTER_DAYS días, ni uno más) todavía NO se considera "más de"', async () => {
      await sembrarGusto('Nico', 'Berserk');
      await sembrarPreviousMessageAt('Nico', haceDias(RETURNING_AFTER_DAYS));

      const linea = await service.build('Nico', 'hola');

      expect(linea).not.toMatch(/vuelve después de/i);
    });

    it('uno sin previousMessageAt (primera vez que se le ve) NO la recibe', async () => {
      await sembrarGusto('Nico', 'Berserk');

      const linea = await service.build('Nico', 'hola');

      expect(linea).not.toMatch(/vuelve después de/i);
    });

    it('la nota incluye su gusto más fuerte, si tiene alguno', async () => {
      await sembrarGusto('Nico', 'Berserk', 5);
      await sembrarGusto('Nico', 'Poco Reforzado', 1);
      await sembrarPreviousMessageAt('Nico', haceDias(RETURNING_AFTER_DAYS + 6));

      const linea = await service.build('Nico', 'hola');

      // La nota de regreso es su propio segmento (termina en el próximo ';'
      // que abre la sección "le gusta"): el gusto que carga tiene que ser el
      // más fuerte (Berserk, mayor peso), no "Poco Reforzado".
      const nota = linea.match(/vuelve después de \d+ días sin escribir; su gusto más fuerte es ([^;]+)/i);
      expect(nota).not.toBeNull();
      expect(nota![1]).toBe('Berserk');
    });

    it('alguien que vuelve pero no tiene gustos guardados recibe la nota igual, sin inventar uno', async () => {
      // Sin sembrarGusto, sin lastNode, sin ninguna otra arista: la ÚNICA
      // señal en el grafo es previousMessageAt. Si el corte temprano de
      // `build()` no considerara la nota de regreso, esto devolvería '' --
      // exactamente el caso que la revisión final de esta tarea señaló.
      await sembrarPreviousMessageAt('Nico', haceDias(RETURNING_AFTER_DAYS + 6));

      const linea = await service.build('Nico', 'hola');

      expect(linea).toMatch(/vuelve después de \d+ días sin escribir/i);
      // Ningún gusto inventado: la nota termina con "sin escribir" (más el
      // punto final de la línea, si no hay más secciones), sin agregar
      // "su gusto más fuerte es" cuando no hay ningún `likes`.
      expect(linea).not.toMatch(/su gusto más fuerte/i);
      expect(linea).toBe(`Sobre Nico: vuelve después de ${RETURNING_AFTER_DAYS + 6} días sin escribir.`);
    });

    it('respeta el tope de caracteres con TODAS las secciones activas a la vez (gustos, recomendados, candidatas, interlocutores, lo mencionado, lo último visto y la nota de regreso)', async () => {
      // Gustos (varios, para ejercitar la sección "le gusta").
      const { u } = await sembrarGusto('Nico', 'Berserk', 10);
      await sembrarGusto('Nico', 'Vinland Saga', 8);

      // Recomendado.
      const rec = await graph.upsertNode({ type: 'work', key: 'ORV', label: 'ORV' });
      await graph.upsertEdge({ from: u._id, to: rec!._id, type: 'recommended_to', source: 'signal' });

      // Interlocutor.
      const kei = await graph.upsertNode({ type: 'user', key: 'kei', label: 'kei' });
      await graph.upsertEdge({ from: u._id, to: kei!._id, type: 'interacts_with', source: 'signal' });

      // Lo último que miró (dentro de la ventana).
      await sembrarLastNode('Nico', 'Frieren');

      // Candidatas colaborativas (>= MIN_CANDIDATES): alguien más que
      // comparte el gusto por Berserk, con >= MIN_CANDIDATES obras propias.
      const otro = await graph.upsertNode({ type: 'user', key: 'rin', label: 'rin' });
      const berserk = await graph.findNode('work', 'Berserk');
      await graph.upsertEdge({ from: otro!._id, to: berserk!._id, type: 'likes', source: 'fact' });
      for (let i = 0; i < MIN_CANDIDATES; i++) {
        const cand = await graph.upsertNode({ type: 'work', key: `candidata${i}`, label: `Candidata ${i}` });
        await graph.upsertEdge({ from: otro!._id, to: cand!._id, type: 'likes', source: 'fact' });
      }

      // Nota de regreso.
      await sembrarPreviousMessageAt('Nico', haceDias(RETURNING_AFTER_DAYS + 20));

      const linea = await service.build('Nico', 'bot que onda con berserk?');

      // Todas las secciones están presentes -- si alguna se hubiera omitido
      // por accidente en vez de recortarse, esta prueba no estaría
      // ejercitando el caso que dice cubrir.
      expect(linea).toMatch(/vuelve después de \d+ días sin escribir/i);
      expect(linea).toMatch(/le gusta/i);
      expect(linea).toMatch(/ya le recomendé/i);
      expect(linea).toMatch(/gustos parecidos/i);
      expect(linea).toMatch(/interactuó con/i);
      expect(linea).toMatch(/lo último que miró fue/i);
      expect(linea).toMatch(/preguntó por berserk/i);

      expect(linea.length).toBeLessThanOrEqual(MAX_CHARS);

      // Ningún fragmento colgando: ningún verbo/preposición de sección
      // termina sin su objeto detrás (el recorte, si hizo falta, no dejó a
      // medias ninguna de las frases-gancho conocidas).
      expect(linea.endsWith(';')).toBe(false);
      expect(linea.trim().endsWith('.')).toBe(true);
    });
  });
});
