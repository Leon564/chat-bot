import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { GraphService } from './graph.service';
import { EdgeType, EDGE_TYPES } from '../../common/schemas/graph-edge.schema';

/**
 * Término mínimo aceptado por `!olvida <término>`. Por debajo de esto un
 * match por igualdad normalizada es demasiado propenso a un choque
 * accidental con un destino que no es el que la persona tenía en mente —
 * ver `forget`/`findForgettable`.
 */
export const MIN_FORGET_TERM_LENGTH = 3;

/** Una arista saliente resuelta como candidata a borrado por `!olvida`. */
interface ForgettableEdge {
  edgeId: Types.ObjectId;
  relation: EdgeType;
  label: string;
  weight: number;
}

/**
 * Tope duro de hechos devueltos por `describe`. Existe para que un usuario
 * muy activo (cientos de aristas acumuladas) no genere un muro de texto en el
 * chat — se aplica en la propia consulta a `GraphService.topEdges`, así que
 * Mongo nunca devuelve más de esto, sea cual sea el historial del usuario.
 */
export const MAX_FACTS_SHOWN = 40;

/**
 * Un hecho del grafo listo para mostrarle a la persona sobre la que habla:
 * la relación cruda (para que el llamador decida cómo traducirla a texto
 * legible) y el label del nodo destino ya resuelto.
 */
export interface UserFact {
  relation: EdgeType;
  label: string;
  weight: number;
}

/**
 * Resuelve "qué tiene el bot guardado" sobre un usuario, para el comando
 * `!quesabes`. Deliberadamente de sólo lectura y sin llamadas al modelo: se
 * resuelve enteramente contra el grafo, igual que `GraphContextService`.
 *
 * No reusa `GraphContextService` porque esa clase arma una línea de contexto
 * PARA EL PROMPT (acotada a `CONTEXT_EDGE_TYPES` y recortada a `MAX_CHARS`) y
 * oculta explícitamente qué arista es cuál. `!quesabes` necesita lo opuesto:
 * TODAS las relaciones (incluidas `dislikes`, `asked_about`, `requested`, que
 * el contexto del prompt no muestra) devueltas como datos estructurados que
 * el llamador agrupa y etiqueta.
 */
@Injectable()
export class GraphUserService {
  private readonly logger = new Logger(GraphUserService.name);

  constructor(private readonly graph: GraphService) {}

  /**
   * Todas las relaciones salientes de `username`, ordenadas por peso
   * descendente y acotadas a `MAX_FACTS_SHOWN`. Nunca lanza: si el usuario no
   * existe en el grafo, o si cualquier consulta falla, devuelve `[]` — el
   * comando responde "no tengo nada guardado", nunca un error.
   *
   * `GraphService.topEdges` ya ordena por `weight` descendente y aplica el
   * límite en la propia agregación de Mongo (`$limit`) antes de resolver el
   * label del nodo destino — pasarle `EDGE_TYPES` (todos los tipos) y
   * `MAX_FACTS_SHOWN` como límite alcanza para "traer todas las aristas
   * salientes, cortadas en el tope": no hace falta un método nuevo en
   * `GraphService` que traiga TODO sin límite y corte después en memoria,
   * porque el corte ya lo necesitamos igual a `MAX_FACTS_SHOWN` — dejar que
   * Mongo lo aplique en la consulta es estrictamente mejor (menos datos
   * viajando) y `topEdges` no le pone un techo bajo a `limit`.
   */
  async describe(username: string): Promise<UserFact[]> {
    try {
      if (!username || !username.trim()) return [];

      const userNode = await this.graph.findNode('user', username);
      if (!userNode) return [];

      const edges = await this.graph.topEdges(userNode._id, EDGE_TYPES, MAX_FACTS_SHOWN);

      return edges.map((edge) => ({
        relation: edge.type,
        label: edge.label,
        weight: edge.weight,
      }));
    } catch (err) {
      this.logger.warn(`describe falló, se responde sin datos: ${(err as Error).message}`);
      return [];
    }
  }

  // ─── !olvida ────────────────────────────────────────────────────────────

  /**
   * Resolución COMPARTIDA entre `findForgettable` y `forget`: qué aristas
   * SALIENTES de `username` matchean `term` por etiqueta o alias del nodo
   * destino, normalizando con `GraphService.normalizeKey` (case/acentos
   * insensible). Se extrae a un único lugar a propósito — en este proyecto
   * ya pasó dos veces que dos caminos que debían resolver lo mismo (dos
   * normalizaciones, dos parseos de hechos) divergieron con el tiempo. Si
   * `findForgettable` y `forget` cada uno reimplementara este match, uno
   * podría "ver" un destino que el otro no borra (o viceversa) sin que nadie
   * lo notara.
   *
   * Sólo consulta aristas `from: userNode._id` — nunca `to: userNode._id` —
   * así que lo que OTRA persona tiene guardado sobre `username` (p. ej. la
   * mitad de `interacts_with` que registra que alguien le habló a `username`)
   * jamás puede aparecer acá, ni por accidente de query.
   *
   * Un término vacío o de menos de `MIN_FORGET_TERM_LENGTH` caracteres es
   * demasiado ambiguo para resolver aristas a ciegas — se rechaza acá mismo,
   * sin tocar el grafo, para que ni `findForgettable` ni `forget` puedan
   * ejecutar un borrado de bajo esfuerzo aunque el llamador se salte la
   * validación de `bot.service.ts`.
   */
  private async resolveForgettable(username: string, term: string): Promise<ForgettableEdge[]> {
    const rawTerm = (term ?? '').trim();
    if (rawTerm.length < MIN_FORGET_TERM_LENGTH) return [];

    const needle = this.graph.normalizeKey(rawTerm);
    if (!needle) return [];

    const userNode = await this.graph.findNode('user', username);
    if (!userNode) return [];

    const edges = await this.graph.edgesFrom(userNode._id);
    if (edges.length === 0) return [];

    const nodes = await this.graph.findNodesByIds(edges.map((e) => e.to));
    const nodeById = new Map(nodes.map((n) => [n._id.toString(), n]));

    const matches: ForgettableEdge[] = [];
    for (const edge of edges) {
      const node = nodeById.get(edge.to.toString());
      if (!node) continue; // destino huérfano: no debería pasar, pero no es un match válido.

      const matchesLabel = this.graph.normalizeKey(node.label) === needle;
      const matchesAlias = (node.aliases ?? []).includes(needle);
      if (!matchesLabel && !matchesAlias) continue;

      matches.push({
        edgeId: edge._id as Types.ObjectId,
        relation: edge.type,
        label: node.label,
        weight: edge.weight,
      });
    }
    return matches;
  }

  /**
   * Vista previa de lo que `forget(username, term)` borraría, SIN borrar
   * nada — pensado para que `!olvida <término>` pueda mostrarle a la persona
   * qué encontró antes (o en el mismo mensaje) de ejecutar el borrado. Nunca
   * lanza: un fallo del grafo se traduce en "no encontré nada", igual que
   * `describe`.
   */
  async findForgettable(username: string, term: string): Promise<UserFact[]> {
    try {
      const matches = await this.resolveForgettable(username, term);
      return matches.map(({ relation, label, weight }) => ({ relation, label, weight }));
    } catch (err) {
      this.logger.warn(`findForgettable falló, se responde sin datos: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Borra las aristas SALIENTES de `username` cuyo destino matchea `term`
   * (misma resolución que `findForgettable`, ver `resolveForgettable`).
   *
   * Borra por `_id` exacto de las aristas ya resueltas
   * (`GraphService.deleteEdgesByIds`), nunca con un filtro amplio tipo
   * `deleteMany({from: userId, ...algo})` — resolver primero, borrar
   * exactamente eso, es lo que garantiza que nunca se borre de más aunque el
   * término matchee varios destinos a la vez. Nunca borra nodos.
   *
   * Devuelve cuántas aristas borró. Nunca lanza: un fallo del grafo se
   * traduce en "no borré nada" (0), no en un error hacia el usuario.
   */
  async forget(username: string, term: string): Promise<number> {
    try {
      const matches = await this.resolveForgettable(username, term);
      if (matches.length === 0) return 0;
      return await this.graph.deleteEdgesByIds(matches.map((m) => m.edgeId));
    } catch (err) {
      this.logger.warn(`forget falló, no se borró nada: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Borra TODAS las aristas SALIENTES de `username` — el equivalente a
   * "olvidate de todo lo mío". Sólo toca `from: userNode._id`
   * (`GraphService.deleteEdgesFrom`); las aristas ENTRANTES (lo que OTROS
   * tienen guardado sobre esta persona) nunca se tocan, y el nodo del propio
   * usuario tampoco se borra — sólo sus aristas.
   *
   * Nota sobre `interacts_with`: esa relación es bidireccional — cuando Nico
   * y kei se hablan, se registran DOS aristas, Nico→kei (dato de Nico: "yo
   * hablé con kei") y kei→Nico (dato de kei: "yo hablé con Nico"). `!olvida
   * todo` de Nico borra sólo la primera. La segunda no es "menos suya" por
   * apuntar de vuelta a Nico — es un hecho que le pertenece a KEI, y
   * borrarla sería tocar datos ajenos aunque el par de nodos involucrado sea
   * el mismo. Si en algún momento a alguien le parece "raro" que sigan
   * quedando aristas kei→Nico después de que Nico se olvida de todo: es a
   * propósito, no un bug pendiente.
   *
   * Nunca lanza: un fallo del grafo se traduce en "no borré nada" (0).
   */
  async forgetAll(username: string): Promise<number> {
    try {
      const userNode = await this.graph.findNode('user', username);
      if (!userNode) return 0;
      return await this.graph.deleteEdgesFrom(userNode._id);
    } catch (err) {
      this.logger.warn(`forgetAll falló, no se borró nada: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Cuenta cuántas aristas borraría `forgetAll(username)`, SIN borrar nada.
   * Existe para que `!olvida todo` pueda mostrar el conteo ANTES de que la
   * persona confirme (`!olvida todo si`) — usa la misma condición
   * (`from: userNode._id`, vía `GraphService.countEdgesFrom`) que después
   * ejecuta el borrado, así que el número mostrado en la confirmación y lo
   * efectivamente borrado nunca pueden divergir.
   */
  async countForgettableAll(username: string): Promise<number> {
    try {
      const userNode = await this.graph.findNode('user', username);
      if (!userNode) return 0;
      return await this.graph.countEdgesFrom(userNode._id);
    } catch (err) {
      this.logger.warn(`countForgettableAll falló, se responde 0: ${(err as Error).message}`);
      return 0;
    }
  }
}
