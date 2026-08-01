import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  GraphNode,
  GraphNodeDocument,
  NodeType,
} from '../../common/schemas/graph-node.schema';
import {
  GraphEdge,
  GraphEdgeDocument,
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

@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);

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
      .replace(/[̀-ͯ]/g, '')
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
        new: true,
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
}
