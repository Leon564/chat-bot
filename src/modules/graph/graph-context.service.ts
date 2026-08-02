import { Injectable, Logger } from '@nestjs/common';
import { GraphService, TopEdge, Candidate, MIN_CANDIDATES, MAX_CANDIDATES } from './graph.service';
import { GraphNodeDocument, LastNodeProp, NodeType } from '../../common/schemas/graph-node.schema';
import { EdgeType } from '../../common/schemas/graph-edge.schema';

/**
 * Cuántas aristas como máximo entran a la línea de contexto. Se aplica en la
 * propia consulta a `topEdges` — no hay forma de que el grafo devuelva más de
 * esto, sea cual sea el historial del usuario.
 */
export const MAX_EDGES = 6;

/**
 * Tope duro de caracteres de la línea final. Es la garantía de que el
 * contexto no crece con el uso: si el resultado se pasa, se recorta en el
 * último límite de palabra completo antes de este tope.
 */
export const MAX_CHARS = 400;

/** Relaciones que alimentan la línea de contexto, en el orden en que se agrupan al renderizar. */
const CONTEXT_EDGE_TYPES: EdgeType[] = ['likes', 'recommended_to', 'interacts_with'];

/**
 * Ventana dentro de la cual `props.lastNode` todavía cuenta como "lo último
 * que miró". Sin este tope, el bot resolvería "¿y el segundo tomo?" contra
 * algo que la persona consultó hace tres días, no contra el turno anterior.
 */
export const LAST_NODE_WINDOW_MS = 30 * 60 * 1000;

/** Un día, en milisegundos — unidad de `RETURNING_AFTER_DAYS`. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Umbral, en días, a partir del cual alguien que vuelve a escribir se
 * considera que "vuelve después de un tiempo" (Task 4, fase 5b —
 * reconocimiento de regreso). Lee `props.previousMessageAt`, que
 * `GraphIngestService.touchUser` deja con el `lastMessageAt` que el usuario
 * tenía ANTES del mensaje actual — no con el de ahora.
 */
export const RETURNING_AFTER_DAYS = 14;

/**
 * Frases-gancho de cada sección: un verbo/preposición que sin su objeto no
 * dice nada por sí solo. `truncate()` las usa para no dejar un fragmento a
 * medias (p. ej. "...lo último que miró fue" sin nada después) cuando el
 * recorte por límite de palabra cae justo ahí — eso confundiría al modelo
 * más que directamente omitir la sección.
 */
const DANGLING_SUFFIXES = [
  'le gusta',
  'ya le recomendé',
  'a otros con gustos parecidos también les gustó',
  'interactuó con',
  'lo último que miró fue',
  'justo preguntó por',
  'su gusto más fuerte es',
];

/** Tipos de nodo que puede mencionar una pregunta (nunca 'user'). */
const MENTIONABLE_NODE_TYPES: NodeType[] = ['work', 'genre', 'artist', 'track', 'topic'];

/** Palabras vacías cortas para no meter ruido de unigramas en la búsqueda de relevancia. */
const STOPWORDS = new Set([
  'que', 'los', 'las', 'del', 'con', 'por', 'para', 'una', 'uno', 'este',
  'esta', 'esto', 'eso', 'esa', 'ese', 'sobre', 'como', 'pero', 'muy',
  'todo', 'toda', 'todos', 'todas', 'bot',
  'the', 'and', 'for', 'you', 'this', 'that', 'not', 'are', 'was', 'were',
  'about', 'what', 'when', 'where', 'why', 'how',
]);

const MAX_NGRAM_SIZE = 4;
const MIN_UNIGRAM_LENGTH = 3;
const CANDIDATE_CAP = 40;

/**
 * Construye la línea de contexto que se inyecta en el prompt del bot,
 * leyendo el grafo de conocimiento. Reemplaza el volcado plano de "las
 * últimas 3 memorias" por algo relevante a lo que se preguntó y acotado en
 * tamaño — ver `MAX_EDGES`/`MAX_CHARS`.
 *
 * Es de sólo lectura: nunca crea nodos ni aristas. Si el usuario no existe en
 * el grafo (o cualquier otra cosa falla), devuelve `''` — el bot se queda sin
 * contexto extra, nunca sin respuesta.
 */
@Injectable()
export class GraphContextService {
  private readonly logger = new Logger(GraphContextService.name);

  constructor(private readonly graph: GraphService) {}

  async build(username: string, message: string): Promise<string> {
    try {
      if (!username || !username.trim()) return '';

      const userNode = await this.graph.findNode('user', username);
      if (!userNode) return '';

      const edges = await this.graph.topEdges(userNode._id, CONTEXT_EDGE_TYPES, MAX_EDGES);
      const lastNode = this.resolveLastNode(userNode);
      const previousMessageAt = this.resolvePreviousMessageAt(userNode);
      const returningNote = this.resolveReturningNote(edges, previousMessageAt);

      // Alguien que vuelve después de mucho tiempo pero no tiene ningún
      // `likes`/`recommended_to`/`interacts_with` ni `lastNode` reciente
      // igual merece la nota de regreso — sin esta condición extra, el corte
      // temprano de abajo la descartaría en silencio junto con el resto.
      if (edges.length === 0 && !lastNode && !returningNote) return '';

      const highlight = await this.resolveHighlight(message, edges);
      // Sólo lectura, igual que el resto de este método: si el usuario no
      // tiene ningún `likes` hacia una obra, `collaborative` devuelve vacío
      // sin tocar Mongo de más (ver el corte temprano en `GraphService`).
      const candidates = await this.graph.collaborative(userNode._id, MAX_CANDIDATES);

      const line = this.render(
        userNode.label || username,
        edges,
        highlight,
        lastNode,
        candidates,
        returningNote,
      );
      return this.truncate(line);
    } catch (err) {
      this.logger.warn(`build falló, se sigue sin contexto extra: ${(err as Error).message}`);
      return '';
    }
  }

  /**
   * Si el mensaje menciona una obra/tema con el que el usuario ya tiene una
   * relación en `edges`, devuelve el label tal como está guardado en esa
   * arista — para señalarlo explícitamente en la línea. `null` si no hay
   * match, o si el match no tiene ninguna arista real del usuario (no se
   * inventa relevancia sobre un nodo que el usuario nunca tocó).
   *
   * La comparación es por `key` (identidad real del nodo, vía `TopEdge.key`),
   * no por `label` normalizado: un nodo `work` ingresado desde AniList tiene
   * `key = 'anilist:<id>'` y `label` = título mostrable — son distintos a
   * propósito (ver `GraphIngestService.ingestAniList`), así que comparar por
   * label calzaría sólo por coincidencia en fixtures donde ambos son iguales,
   * y fallaría en silencio para esas obras en producción.
   */
  private async resolveHighlight(message: string, edges: TopEdge[]): Promise<string | null> {
    const candidates = this.extractCandidates(message);
    if (candidates.length === 0) return null;

    const node = await this.graph.resolveAnyAlias(candidates, MENTIONABLE_NODE_TYPES);
    if (!node) return null;

    const matchedEdge = edges.find((e) => e.key === node.key);
    return matchedEdge ? matchedEdge.label : null;
  }

  /**
   * Lee `props.lastNode` del nodo de usuario y lo devuelve sólo si sigue
   * dentro de `LAST_NODE_WINDOW_MS`. `null` si no hay lastNode, si viene mal
   * formado, o si ya venció la ventana — en cualquiera de esos casos no hay
   * "lo último que miró" que valga la pena señalar.
   */
  private resolveLastNode(userNode: GraphNodeDocument): LastNodeProp | null {
    const raw = (userNode.props as Record<string, unknown> | undefined)?.lastNode as
      | Partial<LastNodeProp>
      | undefined;
    if (!raw || !raw.label || !raw.at) return null;

    const at = new Date(raw.at);
    if (Number.isNaN(at.getTime())) return null;
    if (Date.now() - at.getTime() > LAST_NODE_WINDOW_MS) return null;

    return { key: raw.key ?? '', type: raw.type ?? 'topic', label: raw.label, at };
  }

  /**
   * Lee `props.previousMessageAt` del nodo de usuario -- el `lastMessageAt`
   * que tenía ANTES del mensaje actual, escrito por
   * `GraphIngestService.touchUser`. `null` si nunca se escribió (primer
   * mensaje de la persona) o si viene mal formado.
   */
  private resolvePreviousMessageAt(userNode: GraphNodeDocument): Date | null {
    const raw = (userNode.props as Record<string, unknown> | undefined)?.previousMessageAt as
      | string
      | Date
      | undefined;
    if (!raw) return null;

    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) return null;
    return at;
  }

  /**
   * Si `previousMessageAt` es de hace más de `RETURNING_AFTER_DAYS`, arma el
   * dato crudo de que esta persona vuelve después de un tiempo -- nunca el
   * saludo: el tono lo pone el modelo con su propia voz (personalidad
   * configurable), no el código. Si además tiene algún `likes`, se agrega el
   * más fuerte (el primero de `edges` filtrado por tipo -- `edges` ya viene
   * ordenado por peso desde `topEdges`); si no tiene ninguno, la nota se
   * arma igual, sin inventar un gusto.
   *
   * `null` si no hay `previousMessageAt`, o si no pasó suficiente tiempo
   * todavía (alguien que escribió ayer NO es "alguien que vuelve").
   */
  private resolveReturningNote(edges: TopEdge[], previousMessageAt: Date | null): string | null {
    if (!previousMessageAt) return null;

    const daysSince = Math.floor((Date.now() - previousMessageAt.getTime()) / DAY_MS);
    if (daysSince <= RETURNING_AFTER_DAYS) return null;

    const strongestLike = edges.find((e) => e.type === 'likes')?.label ?? null;
    const base = `vuelve después de ${daysSince} días sin escribir`;
    return strongestLike ? `${base}; su gusto más fuerte es ${strongestLike}` : base;
  }

  /**
   * Agrupa por tipo de relación para que el modelo distinga "le gusta" de "ya
   * le recomendé".
   *
   * `lastNode` ("lo último que miró") va DESPUÉS de gustos/recomendados/
   * interacciones (que son relaciones estables, reforzadas con el tiempo) y
   * ANTES de `highlight` ("justo preguntó por X", que es sobre el mensaje
   * actual): las dos últimas secciones son las que hablan del turno reciente,
   * y quedan juntas al final para que el modelo las lea como "esto es lo
   * inmediato" — sin mezclarse con "esto es lo que le gusta", que es harina
   * de otro costal (literalmente: es la sección anterior, con su propio
   * marcador). El verbo elegido ("miró", no "le gusta" ni "pidió") es a
   * propósito neutro: mirar algo no implica que guste, así que el modelo no
   * puede confundir "lo último que miró" con una preferencia.
   *
   * Las candidatas de `collaborative` (Task 3, fase 5b) se agregan justo
   * después de "ya le recomendé": ambas secciones son sobre sugerencias
   * (una ya dada, otra nueva), así que quedan agrupadas — y ANTES de
   * interacciones/lastNode/highlight, que son sobre el turno reciente, no
   * sobre gustos. Señaladas explícitamente como algo que le gustó A OTROS
   * ("a otros con gustos parecidos también les gustó..."), nunca como algo
   * que el propio usuario ya tiene — mezclarlas con "le gusta" haría que el
   * modelo las confundiera con una preferencia ya confirmada del usuario.
   * Sólo se muestran con al menos `MIN_CANDIDATES`: por debajo de eso sería
   * "le gustó a alguien más" apoyado en una sola coincidencia, que no es
   * una señal de comunidad real.
   *
   * La nota de regreso (Task 4, fase 5b) va PRIMERO, antes que gustos y todo
   * lo demás: es la sección que más vale la pena proteger de un recorte por
   * `MAX_CHARS` (ver `truncate()`, que corta por el final de la línea) --
   * saber que alguien no escribía hace rato es justo el dato que más cambia
   * cómo el modelo abre la respuesta.
   */
  private render(
    displayName: string,
    edges: TopEdge[],
    highlight: string | null,
    lastNode: LastNodeProp | null,
    candidates: Candidate[],
    returningNote: string | null,
  ): string {
    const likes = edges.filter((e) => e.type === 'likes').map((e) => e.label);
    const recommended = edges.filter((e) => e.type === 'recommended_to').map((e) => e.label);
    const interactions = edges.filter((e) => e.type === 'interacts_with').map((e) => e.label);

    const segments: string[] = [];
    if (returningNote) segments.push(returningNote);
    if (likes.length > 0) segments.push(`le gusta ${likes.join(', ')}`);
    if (recommended.length > 0) segments.push(`ya le recomendé ${recommended.join(', ')}`);
    if (candidates.length >= MIN_CANDIDATES) {
      segments.push(`a otros con gustos parecidos también les gustó ${candidates.map((c) => c.label).join(', ')}`);
    }
    if (interactions.length > 0) segments.push(`interactuó con ${interactions.join(', ')}`);
    if (lastNode) segments.push(`lo último que miró fue ${lastNode.label}`);
    if (highlight) segments.push(`justo preguntó por ${highlight}`);

    if (segments.length === 0) return '';

    return `Sobre ${displayName}: ${segments.join('; ')}.`;
  }

  /**
   * Recorta al límite de palabra completo más cercano por debajo de
   * `MAX_CHARS`. El corte por espacio sólo garantiza no partir una PALABRA a
   * la mitad — no garantiza no partir un LABEL a la mitad, porque los
   * títulos reales de AniList tienen espacios internos (Task 2, fase 5b:
   * "Shingeki no Kyojin: The Final Season", "Fate/stay night", "Re:Zero kara
   * Hajimeru Isekai Seikatsu"). Medido sobre la línea cargada real (hallazgo
   * B3 de la revisión final de fase 5b): el corte por palabra dejaba
   * "Shingeki no Kyojin:" — que es una obra DISTINTA y real. El modelo no
   * tiene forma de saber que está truncado: lee esa afirmación falsa con la
   * misma autoridad que las verdaderas, y puede terminar recomendando la
   * obra equivocada.
   *
   * Por eso, después del corte por palabra, se retrocede además hasta el
   * último separador de ÍTEM COMPLETO (", " o "; ") — pero SÓLO si hace
   * falta: si `trimmed` (el resultado del corte por palabra) YA termina en
   * una coma, un punto y coma o un punto, el corte cayó en un borde real de
   * todos modos y no hay nada que arreglar (evita retroceder de más cuando
   * no hace falta, como en un listado de labels cortos donde el corte por
   * palabra ya coincide con el fin de un ítem). Lo que sigue DESPUÉS del
   * corte no sirve para esta pregunta: ahí siempre empieza el ítem
   * siguiente (o lo que quedó de un label partido a la mitad), así que
   * nunca va a ser puntuación aunque el corte ya esté en un borde limpio —
   * por eso el guard mira el final de `trimmed`, no el principio del resto.
   *
   * El guard de `DANGLING_SUFFIXES` sigue siendo necesario DESPUÉS de este
   * retroceso: si la sección entera (verbo + label) queda sin ningún
   * separador previo al que volver (ver más abajo), el verbo puede quedar
   * colgando sin objeto igual que antes.
   */
  private truncate(line: string): string {
    if (line.length <= MAX_CHARS) return line;

    const sliced = line.slice(0, MAX_CHARS);
    const lastSpace = sliced.lastIndexOf(' ');
    let trimmed = lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced;

    // ¿`trimmed` ya termina en un borde real de ítem (coma/punto y
    // coma/punto), o quedó a mitad de un label más largo? Sólo en el
    // segundo caso hace falta retroceder más. Mirar el lado de ADENTRO del
    // corte (el final de `trimmed`) en vez de lo que sigue después es lo
    // que importa: lo que sigue siempre empieza el próximo ítem (o el resto
    // de un label partido), así que nunca es puntuación aunque el corte ya
    // esté en un borde limpio.
    const cortoEnBordeDeItem = /[,;.]$/.test(trimmed);

    if (!cortoEnBordeDeItem) {
      const lastComma = trimmed.lastIndexOf(', ');
      const lastSemicolon = trimmed.lastIndexOf('; ');
      const lastSeparator = Math.max(lastComma, lastSemicolon);

      if (lastSeparator > 0) {
        // Hay un ítem anterior completo al que volver: se descarta entero
        // el ítem a medias que cruzaba el límite, en vez de mostrar su
        // fragmento.
        trimmed = trimmed.slice(0, lastSeparator);
      }
      // Si no hay NINGÚN separador de ítem (una sola arista con un label
      // larguísimo que por sí solo ya cruza MAX_CHARS, como el caso ya
      // cubierto por el test de arriba): no hay a dónde retroceder sin
      // vaciar la sección entera. Se deja pasar el fragmento a medias del
      // label — el guard de DANGLING_SUFFIXES de abajo igual limpia el caso
      // en que el verbo quedó totalmente sin objeto (label entero
      // excluido). Preferir vaciar la sección completa acá sería más
      // agresivo de lo necesario en el caso común (un solo label largo,
      // sin otra obra real con la que confundirse); el label sigue siendo
      // UN fragmento del propio label, no el nombre de otra obra distinta,
      // así que el riesgo que este fix ataca (confundirse con otra obra
      // real) no aplica igual acá.
    }

    for (const suffix of DANGLING_SUFFIXES) {
      if (trimmed.endsWith(suffix)) {
        trimmed = trimmed
          .slice(0, trimmed.length - suffix.length)
          .replace(/[;:]\s*$/, '')
          .trimEnd();
        break;
      }
    }

    return trimmed;
  }

  /**
   * Versión simple de extracción de n-gramas del mensaje (1 a 4 palabras),
   * para resolver de qué obra/tema habla la pregunta. Inspirada en el
   * extractor de `IntentRouterService`, pero deliberadamente propia: este
   * módulo no puede depender de `ChatModule`.
   */
  private extractCandidates(message: string): string[] {
    const normalized = this.graph.normalizeKey(message);
    if (!normalized) return [];

    const words = normalized
      .replace(/[,;]+/g, ' ')
      .split(/\s+/)
      .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
      .filter(Boolean);

    const candidates: string[] = [];
    for (let size = MAX_NGRAM_SIZE; size >= 1; size--) {
      for (let i = 0; i + size <= words.length; i++) {
        if (size === 1 && !this.isPlausibleWord(words[i])) continue;
        candidates.push(words.slice(i, i + size).join(' '));
        if (candidates.length >= CANDIDATE_CAP) return candidates;
      }
    }
    return candidates;
  }

  private isPlausibleWord(word: string): boolean {
    return word.length >= MIN_UNIGRAM_LENGTH && !STOPWORDS.has(word);
  }
}
