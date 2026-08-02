import { Injectable, Logger } from '@nestjs/common';
import { GraphService } from './graph.service';
import { EdgeType, EDGE_TYPES } from '../../common/schemas/graph-edge.schema';

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
}
