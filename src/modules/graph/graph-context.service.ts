import { Injectable, Logger } from '@nestjs/common';
import { GraphService, TopEdge } from './graph.service';
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
  'interactuó con',
  'lo último que miró fue',
  'justo preguntó por',
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

      if (edges.length === 0 && !lastNode) return '';

      const highlight = await this.resolveHighlight(message, edges);

      const line = this.render(userNode.label || username, edges, highlight, lastNode);
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
   */
  private render(
    displayName: string,
    edges: TopEdge[],
    highlight: string | null,
    lastNode: LastNodeProp | null,
  ): string {
    const likes = edges.filter((e) => e.type === 'likes').map((e) => e.label);
    const recommended = edges.filter((e) => e.type === 'recommended_to').map((e) => e.label);
    const interactions = edges.filter((e) => e.type === 'interacts_with').map((e) => e.label);

    const segments: string[] = [];
    if (likes.length > 0) segments.push(`le gusta ${likes.join(', ')}`);
    if (recommended.length > 0) segments.push(`ya le recomendé ${recommended.join(', ')}`);
    if (interactions.length > 0) segments.push(`interactuó con ${interactions.join(', ')}`);
    if (lastNode) segments.push(`lo último que miró fue ${lastNode.label}`);
    if (highlight) segments.push(`justo preguntó por ${highlight}`);

    if (segments.length === 0) return '';

    return `Sobre ${displayName}: ${segments.join('; ')}.`;
  }

  /**
   * Recorta al límite de palabra completo más cercano por debajo de
   * `MAX_CHARS`. Además, si ese recorte deja colgando el verbo de una sección
   * sin ningún objeto detrás (p. ej. "...lo último que miró fue" a secas),
   * retrocede hasta el separador anterior — un verbo sin objeto no aporta
   * nada y puede leerse como que el dato se omitió a propósito, no que se
   * cortó por espacio.
   */
  private truncate(line: string): string {
    if (line.length <= MAX_CHARS) return line;

    const sliced = line.slice(0, MAX_CHARS);
    const lastSpace = sliced.lastIndexOf(' ');
    let trimmed = lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced;

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
