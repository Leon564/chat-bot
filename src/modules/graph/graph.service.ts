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
   * Crea o actualiza un nodo. Idempotente por el índice único {type, key}:
   * llamarlo dos veces con la misma key no duplica, solo fusiona alias y
   * props y (opcionalmente) sube el peso.
   */
  async upsertNode(input: UpsertNodeInput): Promise<GraphNodeDocument | null> {
    const key = this.normalizeKey(input.key);
    if (!key) return null;

    const label = (input.label ?? '').trim() || key;
    const aliases = (input.aliases ?? [])
      .map((a) => this.normalizeKey(a))
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
        returnDocument: 'after',
      })
      .exec();
  }

  async findNode(type: NodeType, key: string): Promise<GraphNodeDocument | null> {
    const normalized = this.normalizeKey(key);
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
          },
        },
      ])
      .exec();

    return rows as TopEdge[];
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
          },
        },
      ])
      .exec();

    return rows as TopEdge[];
  }
}
