import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  GraphNode,
  GraphNodeDocument,
  NodeType,
} from '../../common/schemas/graph-node.schema';
import {
  GraphEdge,
  GraphEdgeDocument,
  EdgeType,
  EdgeSource,
} from '../../common/schemas/graph-edge.schema';

export interface UpsertNodeInput {
  type: NodeType;
  key: string;
  label: string;
  aliases?: string[];
  props?: Record<string, unknown>;
  /** Sube el contador de menciones. Falso para nodos creados de refilón. */
  bumpWeight?: boolean;
}

export interface UpsertEdgeInput {
  from: Types.ObjectId;
  to: Types.ObjectId;
  type: EdgeType;
  source: EdgeSource;
}

/**
 * Una obra que le gustó a gente con gustos parecidos al usuario, dentro de
 * esta comunidad — el resultado de `GraphService.collaborative`. `key` es la
 * identidad real del nodo (no el `label`), para que el llamador pueda
 * resolver el nodo destino y marcarlo con `recommended_to` sin otra consulta
 * de por medio que el propio `key`. `score` es la suma de pesos de las
 * aristas `likes` de quienes comparten el gusto — no un conteo de personas.
 */
export interface Candidate {
  key: string;
  label: string;
  score: number;
}

/**
 * Candidatas mínimas para que `GraphContextService` considere confiable la
 * recomendación colaborativa y la mencione en la línea de contexto. Con menos
 * de esto, el bot estaría diciendo "le gustó a alguien más" apoyado en una
 * sola coincidencia — ruido, no señal de comunidad. No gatilla nada en
 * `GraphService.collaborative` en sí (que puede devolver 1 o 2 candidatas sin
 * problema): el umbral es sólo para decidir si vale la pena MOSTRARLAS.
 */
export const MIN_CANDIDATES = 3;

/**
 * Tope de candidatas que `collaborative` devuelve, sea cual sea el tamaño
 * real de la comunidad que las comparte. Lo usan tanto `GraphContextService`
 * (para no inflar la línea de contexto) como `BotService` (para no marcar más
 * de las que se llegaron a mencionar en el prompt).
 */
export const MAX_CANDIDATES = 5;

/**
 * Tope de "pares" (otros usuarios que comparten al menos un gusto con quien
 * pregunta) que entran al paso 4 de `collaborative`. Sin esto, un ancla muy
 * popular — una obra que cientos de personas marcaron con `likes` — puede
 * llevar `peerIds` a un tamaño sin cota antes de llegar al `$group`/`$sort`/
 * `$limit` que arma las candidatas: los índices de `bot_edges` evitan el
 * collscan, pero no acotan cuántos documentos procesa el pipeline. 200 es un
 * número elegido para que la comunidad muestreada siga siendo representativa
 * (mucho más que el puñado de coincidencias que hace falta para superar
 * `MIN_CANDIDATES`) sin dejar que una obra masiva dispare el volumen. No es
 * un corte arbitrario de los primeros 200 que aparezcan: se prioriza a los
 * pares cuyo propio `likes` hacia el ancla tiene más peso (`$sort` antes del
 * `$limit`), así que si hay que recortar, se recorta por los que menos
 * fuerte comparten el gusto, no al azar.
 */
export const MAX_PEERS = 200;

export interface TopEdge {
  type: EdgeType;
  weight: number;
  label: string;
  nodeType: NodeType;
  /**
   * Cuándo se reforzó esta arista por última vez. Se agrega en la fase 3 del
   * router (`intent-router.service.ts`) para aproximar "hilo reciente" con
   * una ventana temporal — no rompe a los llamadores existentes, que sólo
   * leen `label`/`weight`/`type`/`nodeType`.
   */
  lastSeenAt: Date;
  /**
   * Identidad canónica del nodo destino (`GraphNode.key`), no su `label`.
   * Se agrega en la fase 4 (`graph-context.service.ts`) para poder comparar
   * "¿esta arista apunta al mismo nodo que resolvió la pregunta?" por
   * identidad real — comparar por `label` normalizado se rompe apenas un
   * nodo tiene `key` e_id distintos de su label (p. ej. las obras de AniList,
   * cuyo `key` es `anilist:<id>` y el `label` es el título). No rompe a los
   * llamadores existentes, que no leen este campo.
   */
  key: string;
}

@Injectable()
export class GraphService {
  constructor(
    @InjectModel(GraphNode.name) private readonly nodeModel: Model<GraphNodeDocument>,
    @InjectModel(GraphEdge.name) private readonly edgeModel: Model<GraphEdgeDocument>,
  ) {}

  /**
   * Identidad canónica de un nodo: minúsculas, sin acentos, espacios
   * colapsados. Se aplica a `key` y a cada alias para que "Canción De Amor" y
   * "cancion de amor" resuelvan al mismo nodo.
   *
   * NO usar esto para nodos `type: 'user'` -- ver `normalizeUserKey`.
   */
  normalizeKey(raw: string): string {
    if (!raw || typeof raw !== 'string') return '';
    return raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  }

  /**
   * Identidad de un nodo `user`: sólo trim de los bordes + minúsculas — a
   * propósito SIN quitar acentos y SIN colapsar espacios internos, a
   * diferencia de `normalizeKey`. Para una obra "cancion" y "canción" son la
   * misma obra, y colapsar "Tower  of God" (doble espacio) a "tower of god"
   * es deseable; para una persona ninguna de las dos cosas es cierta:
   * `UsersService.findByUsername` (backend) resuelve la identidad de un
   * usuario registrado con `new RegExp('^' + username + '$', 'i')` sobre un
   * campo `trim: true` — insensible a mayúsculas, pero exacto (sensible a
   * acentos y a cada espacio interno) en todo lo demás. "José" y "Jose" son
   * —y el backend las trata como— dos cuentas distintas, cada una con su
   * propia contraseña; "Nico Bot" y "Nico  Bot" (doble espacio) también lo
   * son, por la misma razón. Si el grafo colapsara cualquiera de las dos
   * diferencias (que es lo que hacía usar `normalizeKey` acá, antes de este
   * fix, con acentos Y con espacios), cuentas reales distintas colapsan en
   * una sola identidad — y con el borrado que agregó esta fase
   * (`GraphUserService.forgetAll`/`forget`), una persona puede terminar
   * borrando los datos de otra sin saberlo.
   *
   * Esta regla DEBE seguir a la del backend, no a la conveniencia del grafo:
   * si `findByUsername` cambiara de criterio (por ejemplo, para colapsar
   * espacios en el registro), esta función tiene que cambiar con él para
   * seguir resolviendo a la misma identidad que usa el login.
   */
  normalizeUserKey(raw: string): string {
    if (!raw || typeof raw !== 'string') return '';
    return raw.trim().toLowerCase();
  }

  /** `type: 'user'` se identifica con `normalizeUserKey`; cualquier otro tipo con `normalizeKey`. */
  private keyNormalizerFor(type: NodeType): (raw: string) => string {
    return type === 'user'
      ? (raw: string) => this.normalizeUserKey(raw)
      : (raw: string) => this.normalizeKey(raw);
  }

  /**
   * Crea o actualiza un nodo. Idempotente por el índice único {type, key}:
   * llamarlo dos veces con la misma key no duplica, solo fusiona alias y
   * props y (opcionalmente) sube el peso.
   */
  async upsertNode(input: UpsertNodeInput): Promise<GraphNodeDocument | null> {
    return this.upsertNodeWithReturn(input, 'after');
  }

  /**
   * Igual que `upsertNode` en todo (misma normalización de key, misma fusión
   * de aliases/props, mismo `$inc` de peso), salvo que devuelve el documento
   * tal como estaba ANTES de esta escritura -- `null` si el nodo se crea
   * recién ahora, porque entonces no había "antes" -- en vez del resultante.
   *
   * Existe para `GraphIngestService.touchUser` (Task 4, fase 5b —
   * reconocimiento de regreso): para saber cuánto tiempo pasó desde el
   * último mensaje de alguien hace falta el valor de `lastMessageAt` de
   * ANTES de pisarlo con "ahora", y `findOneAndUpdate` con
   * `returnDocument: 'before'` lo da en la misma escritura, sin una lectura
   * previa aparte.
   *
   * `upsertNode` (arriba) NO cambia: sigue devolviendo 'after' para todos sus
   * llamadores existentes, sin ninguna diferencia de comportamiento.
   */
  async upsertNodeReturningPrevious(input: UpsertNodeInput): Promise<GraphNodeDocument | null> {
    return this.upsertNodeWithReturn(input, 'before');
  }

  private async upsertNodeWithReturn(
    input: UpsertNodeInput,
    returnDocument: 'before' | 'after',
  ): Promise<GraphNodeDocument | null> {
    const normalize = this.keyNormalizerFor(input.type);
    const key = normalize(input.key);
    if (!key) return null;

    const label = (input.label ?? '').trim() || key;
    const aliases = (input.aliases ?? [])
      .map((a) => normalize(a))
      .filter((a) => a.length > 0);

    // Las props se escriben con rutas punteadas para FUSIONAR en vez de
    // reemplazar el subdocumento entero — un $set: { props } borraría todo lo
    // guardado antes (p. ej. la sinopsis traducida).
    const set: Record<string, unknown> = { label, lastSeenAt: new Date() };
    for (const [k, v] of Object.entries(input.props ?? {})) {
      set[`props.${k}`] = v;
    }

    const update: Record<string, unknown> = {
      $setOnInsert: { type: input.type, key },
      $set: set,
      $inc: { weight: input.bumpWeight ? 1 : 0 },
    };
    if (aliases.length > 0) {
      update.$addToSet = { aliases: { $each: aliases } };
    }

    return this.nodeModel
      .findOneAndUpdate({ type: input.type, key }, update, {
        upsert: true,
        returnDocument,
      })
      .exec();
  }

  async findNode(type: NodeType, key: string): Promise<GraphNodeDocument | null> {
    const normalized = this.keyNormalizerFor(type)(key);
    if (!normalized) return null;
    return this.nodeModel.findOne({ type, key: normalized }).exec();
  }

  /**
   * Resuelve un texto libre a un nodo, buscando primero entre los alias y
   * luego entre las keys. Si varios nodos comparten el alias gana el de mayor
   * peso — el más mencionado es el más probable.
   */
  async resolveByAlias(alias: string, types?: NodeType[]): Promise<GraphNodeDocument | null> {
    const needle = this.normalizeKey(alias);
    if (!needle) return null;

    const filter: Record<string, unknown> = {
      $or: [{ aliases: needle }, { key: needle }],
    };
    if (types && types.length > 0) filter.type = { $in: types };

    return this.nodeModel.findOne(filter).sort({ weight: -1, lastSeenAt: -1 }).exec();
  }

  /**
   * Igual que `resolveByAlias`, pero exige además que una prop del nodo tenga
   * un valor exacto — filtrando a nivel de Mongo, no eligiendo primero por
   * peso y recién después descartando por no calzar.
   *
   * Existe porque una obra puede estar en el grafo dos veces con el mismo
   * alias — p. ej. "Solo Leveling" como manhwa (muy preguntado, peso alto) y
   * como anime (poco preguntado, peso bajo). `resolveByAlias` siempre
   * devuelve el de mayor peso sin mirar el tipo pedido: pedir el anime
   * resolvía siempre al manhwa, no calzaba el `kind`, y era un miss
   * permanente — justo para las obras más preguntadas, que son las que
   * terminan con entrada doble. Filtrar la prop en la query evita elegir un
   * ganador equivocado para después descartarlo.
   */
  async resolveByAliasAndProp(
    alias: string,
    types: NodeType[] | undefined,
    propKey: string,
    propValue: unknown,
  ): Promise<GraphNodeDocument | null> {
    const needle = this.normalizeKey(alias);
    if (!needle) return null;

    const filter: Record<string, unknown> = {
      $or: [{ aliases: needle }, { key: needle }],
      [`props.${propKey}`]: propValue,
    };
    if (types && types.length > 0) filter.type = { $in: types };

    return this.nodeModel.findOne(filter).sort({ weight: -1, lastSeenAt: -1 }).exec();
  }

  /**
   * Igual que `resolveByAlias` pero para N candidatos en una sola consulta:
   * arma un único `$in` en vez de que el llamador dispare una consulta por
   * candidato. Pensado para el router de intención (`intent-router.service.ts`),
   * que genera hasta 40 n-gramas por mensaje — antes de este método hacía
   * hasta 40 round-trips secuenciales a Mongo por respuesta del bot.
   * Si varios candidatos matchean nodos distintos, gana el de mayor peso.
   */
  async resolveAnyAlias(candidates: string[], types?: NodeType[]): Promise<GraphNodeDocument | null> {
    const needles = Array.from(
      new Set((candidates ?? []).map((c) => this.normalizeKey(c)).filter((c) => c.length > 0)),
    );
    if (needles.length === 0) return null;

    const filter: Record<string, unknown> = {
      $or: [{ aliases: { $in: needles } }, { key: { $in: needles } }],
    };
    if (types && types.length > 0) filter.type = { $in: types };

    return this.nodeModel.findOne(filter).sort({ weight: -1, lastSeenAt: -1 }).exec();
  }

  /**
   * Crea o refuerza una relación. Idempotente por el índice único
   * {from, to, type}: repetirla sube `weight` en vez de duplicar. El `source`
   * se fija en la inserción y no se pisa — una arista nacida de una señal
   * dura no se degrada porque el lote la vuelva a proponer.
   */
  async upsertEdge(input: UpsertEdgeInput): Promise<void> {
    // Un nodo relacionado consigo mismo no aporta nada y ensucia
    // interacts_with cuando alguien se auto-menciona.
    if (input.from.equals(input.to)) return;

    await this.edgeModel
      .updateOne(
        { from: input.from, to: input.to, type: input.type },
        {
          $setOnInsert: {
            from: input.from,
            to: input.to,
            type: input.type,
            source: input.source,
          },
          $inc: { weight: 1 },
          $set: { lastSeenAt: new Date() },
        },
        { upsert: true },
      )
      .exec();
  }

  /**
   * Las relaciones más fuertes de un nodo, con el label del destino resuelto.
   * Es la consulta que alimenta la línea de contexto del prompt (fase 4), por
   * eso resuelve el nodo destino acá y no en el llamador.
   */
  async topEdges(from: Types.ObjectId, types: EdgeType[], limit: number): Promise<TopEdge[]> {
    if (!types.length || limit <= 0) return [];

    const rows = await this.edgeModel
      .aggregate([
        { $match: { from, type: { $in: types } } },
        { $sort: { weight: -1, lastSeenAt: -1 } },
        { $limit: limit },
        {
          $lookup: {
            from: 'bot_nodes',
            localField: 'to',
            foreignField: '_id',
            as: 'node',
          },
        },
        { $unwind: '$node' },
        {
          $project: {
            _id: 0,
            type: 1,
            weight: 1,
            lastSeenAt: 1,
            label: '$node.label',
            nodeType: '$node.type',
            key: '$node.key',
          },
        },
      ])
      .exec();

    return rows as TopEdge[];
  }

  /**
   * Todas las aristas SALIENTES de un nodo, crudas (sin resolver el destino,
   * sin límite). A diferencia de `topEdges` (pensado para mostrar top-N con
   * el label ya resuelto y descartando el `_id` de la arista en el
   * `$project`), esto expone el documento completo — incluido `_id` — para
   * que el llamador pueda borrar por identidad exacta en vez de por un
   * filtro amplio. Usado por `GraphUserService` para `!olvida`: nunca se
   * borra con `deleteMany({from, ...algo})`, sino por los `_id` exactos que
   * esta consulta identificó.
   */
  async edgesFrom(from: Types.ObjectId): Promise<GraphEdgeDocument[]> {
    return this.edgeModel.find({ from }).exec();
  }

  /**
   * Nodos por `_id` en batch — evita N consultas cuando el llamador necesita
   * resolver el destino de varias aristas a la vez (p. ej. `GraphUserService`
   * resolviendo el label/alias de cada destino de `edgesFrom`).
   */
  async findNodesByIds(ids: Types.ObjectId[]): Promise<GraphNodeDocument[]> {
    if (!ids.length) return [];
    return this.nodeModel.find({ _id: { $in: ids } }).exec();
  }

  /**
   * Cuenta las aristas salientes de un nodo sin traerlas ni borrar nada.
   * Usado para mostrarle a quien pide `!olvida todo` cuántas cosas se
   * borrarían ANTES de que confirme — el conteo sale de la misma condición
   * (`from: nodeId`) que después ejecuta `deleteEdgesFrom`, así que el número
   * mostrado y lo efectivamente borrado nunca pueden divergir.
   */
  async countEdgesFrom(from: Types.ObjectId): Promise<number> {
    return this.edgeModel.countDocuments({ from }).exec();
  }

  /**
   * Borra aristas por `_id` exacto. Deliberadamente NO acepta un filtro más
   * amplio (tipo `{from, type}`): el llamador debe haber resuelto ya,
   * puntualmente, cuáles aristas quiere borrar — esta función sólo ejecuta
   * esa lista. Pensado para `GraphUserService.forget`, donde borrar de más
   * (por ejemplo la arista de otro usuario hacia el mismo destino) sería un
   * bug de privacidad, no un detalle de implementación.
   */
  async deleteEdgesByIds(ids: Types.ObjectId[]): Promise<number> {
    if (!ids.length) return 0;
    const result = await this.edgeModel.deleteMany({ _id: { $in: ids } }).exec();
    return result.deletedCount ?? 0;
  }

  /**
   * Borra TODAS las aristas SALIENTES de un nodo (`from: nodeId`). A
   * diferencia de `deleteEdgesByIds`, éste sí es un filtro amplio — pero
   * deliberadamente sólo sobre `from`, nunca sobre `to`: borrar por `from`
   * es exactamente "todo lo que este nodo dijo/hizo hacia otros", nunca toca
   * lo que otros nodos guardan HACIA éste. Ver el comentario en
   * `GraphUserService.forgetAll` sobre por qué eso importa para
   * `interacts_with`, que es bidireccional.
   */
  async deleteEdgesFrom(from: Types.ObjectId): Promise<number> {
    const result = await this.edgeModel.deleteMany({ from }).exec();
    return result.deletedCount ?? 0;
  }

  /**
   * Las relaciones más RECIENTES de un nodo, dentro de una ventana de
   * `sinceMs` milisegundos hacia atrás desde ahora — a diferencia de
   * `topEdges` (que ordena por `weight`), acá se ordena por `lastSeenAt`.
   *
   * Existe porque `IntentRouterService.hasRecentWorkThread` usaba
   * `topEdges` para aproximar "hilo de conversación reciente" y eso está
   * mal: la revisión final encontró que un usuario que preguntó 5 veces
   * por One Piece hace una semana y 1 vez por Frieren hace 10 segundos
   * recibía la arista de One Piece (mayor peso), cuyo `lastSeenAt` cae
   * fuera de cualquier ventana razonable — el comportamiento empeoraba
   * cuanto más se usaba AniList. `topEdges` en sí no cambia: su orden por
   * peso es correcto para lo que otros llamadores necesitan (contexto del
   * prompt en fase 4).
   */
  async recentEdges(
    from: Types.ObjectId,
    types: EdgeType[],
    sinceMs: number,
    limit: number,
  ): Promise<TopEdge[]> {
    if (!types.length || limit <= 0) return [];

    const cutoff = new Date(Date.now() - sinceMs);

    const rows = await this.edgeModel
      .aggregate([
        { $match: { from, type: { $in: types }, lastSeenAt: { $gte: cutoff } } },
        { $sort: { lastSeenAt: -1 } },
        { $limit: limit },
        {
          $lookup: {
            from: 'bot_nodes',
            localField: 'to',
            foreignField: '_id',
            as: 'node',
          },
        },
        { $unwind: '$node' },
        {
          $project: {
            _id: 0,
            type: 1,
            weight: 1,
            lastSeenAt: 1,
            label: '$node.label',
            nodeType: '$node.type',
            key: '$node.key',
          },
        },
      ])
      .exec();

    return rows as TopEdge[];
  }

  /**
   * Recomendación colaborativa: qué le gustó a gente con gustos parecidos al
   * usuario, DENTRO de esta comunidad. Es la razón de ser de todo el grafo —
   * el modelo ya recomienda lo que recomienda internet; esto recomienda lo
   * que le gustó a quien está en esta sala, algo que ninguna otra parte del
   * sistema puede ofrecer.
   *
   * El recorrido: `(usuario)-[likes]->(obra)<-[likes]-(otros)-[likes]->(candidatas)`.
   *
   * Deliberadamente partido en pasos con nombre (obras propias → pares →
   * exclusiones → candidatas) en vez de una única agregación con varios
   * `$lookup` encadenados: esto lo va a mantener alguien más, y una sola
   * consulta gigante es más difícil de auditar que cuatro consultas chicas
   * que se leen en el orden del diagrama de arriba.
   *
   * La garantía que más importa: el recorrido SÓLO puede llegar a nodos
   * `type: 'work'`. Un `likes` puede apuntar a un nodo `topic` suelto — un
   * hecho de texto libre que no resolvió contra `work`/`genre`/`artist` (ver
   * `GraphIngestService.ingestFact`), con una etiqueta como "tiene 25 años".
   * Sin filtrar por tipo tanto en el ancla (paso 1) como en las candidatas
   * (paso 4), el bot terminaría "recomendando" eso.
   *
   * El paso 2 (pares) está acotado por `MAX_PEERS` — ver su comentario para
   * el porqué del número y del criterio de prioridad usado al recortar.
   */
  async collaborative(userId: Types.ObjectId, limit: number): Promise<Candidate[]> {
    if (limit <= 0) return [];

    try {
      // 1. Qué obras (sólo `type: 'work'`) le gustan al usuario — el ancla.
      const myWorkIds = await this.likedWorkIds(userId);
      if (myWorkIds.length === 0) return [];

      // 2. Quién más le puso `likes` a esas mismas obras. Se excluye al
      //    propio usuario explícitamente: por definición ya le gustan esas
      //    obras (son el ancla), así que no cuenta como "otro" que comparte
      //    el gusto. Acotado a `MAX_PEERS`, priorizando (vía `$sort` antes
      //    del `$limit`) a quienes más fuerte comparten el gusto — ver el
      //    comentario de `MAX_PEERS` sobre por qué hace falta este tope.
      const peerRows = await this.edgeModel
        .aggregate([
          { $match: { to: { $in: myWorkIds }, type: 'likes', from: { $ne: userId } } },
          { $group: { _id: '$from', peerWeight: { $max: '$weight' } } },
          { $sort: { peerWeight: -1 } },
          { $limit: MAX_PEERS },
        ])
        .exec();
      const peerIds = peerRows.map((r) => r._id as Types.ObjectId);
      if (peerIds.length === 0) return [];

      // 3. Qué ya tiene el usuario — le gusta o ya se le recomendó — para
      //    excluirlo de las candidatas. Sin esto se repetiría lo obvio (algo
      //    que ya le gusta) o lo ya ofrecido (algo ya recomendado).
      const alreadyHas = await this.edgeModel
        .distinct('to', { from: userId, type: { $in: ['likes', 'recommended_to'] } })
        .exec();

      // 4. Qué le gusta a esos pares: se suma el peso cuando varias personas
      //    coinciden en la misma candidata (más gente reforzando la misma
      //    obra = señal más fuerte), y se filtra OTRA VEZ a `type: 'work'` —
      //    un par puede tener `likes` hacia un `topic` igual que el usuario
      //    original.
      const rows = await this.edgeModel
        .aggregate([
          { $match: { from: { $in: peerIds }, type: 'likes', to: { $nin: alreadyHas } } },
          { $group: { _id: '$to', score: { $sum: '$weight' } } },
          {
            $lookup: {
              from: 'bot_nodes',
              localField: '_id',
              foreignField: '_id',
              as: 'node',
            },
          },
          { $unwind: '$node' },
          { $match: { 'node.type': 'work' } },
          { $sort: { score: -1 } },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              key: '$node.key',
              label: '$node.label',
              score: 1,
            },
          },
        ])
        .exec();

      return rows as Candidate[];
    } catch (err) {
      // Es de sólo lectura y alimenta un contexto opcional del prompt — un
      // fallo acá nunca debe tumbar la respuesta del bot, sólo dejarlo sin
      // esta sugerencia puntual.
      return [];
    }
  }

  /**
   * IDs de nodos `type: 'work'` a los que el usuario le puso `likes` — el
   * ancla de `collaborative`. Separado en su propio método porque es el
   * primer punto donde se aplica el filtro "sólo `work`", y nombrarlo deja
   * claro qué garantiza sin tener que leer la agregación entera.
   */
  private async likedWorkIds(userId: Types.ObjectId): Promise<Types.ObjectId[]> {
    const rows = await this.edgeModel
      .aggregate([
        { $match: { from: userId, type: 'likes' } },
        {
          $lookup: {
            from: 'bot_nodes',
            localField: 'to',
            foreignField: '_id',
            as: 'node',
          },
        },
        { $unwind: '$node' },
        { $match: { 'node.type': 'work' } },
        { $project: { _id: 0, to: 1 } },
      ])
      .exec();

    return rows.map((r) => r.to as Types.ObjectId);
  }
}
