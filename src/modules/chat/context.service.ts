import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Context, ContextDocument } from '../../common/schemas/context.schema';

/** Un turno de conversación ya cerrado. */
export interface ContextPair {
  question: string;
  answer: string;
  user: string;
}

/** Pares que se replayan al modelo por usuario. */
export const MAX_PAIRS_PER_USER = 4;

/** Pares que se replayan en modo compartido, sumando a toda la sala. */
export const MAX_SHARED_PAIRS = 8;

/** Más viejo que esto y ya no es "la conversación en curso". */
export const MAX_AGE_MINUTES = 30;

/**
 * Historial conversacional por usuario.
 *
 * Antes esto vivía dentro de ChatService como una cola FIFO **global** de 10
 * pares: si tres personas hablaban a la vez, cada una recibía las preguntas
 * de las otras como si fueran propias. Además se leía con `sort({createdAt: 1})`
 * — los más VIEJOS — lo que bajo concurrencia servía pares rancios.
 */
@Injectable()
export class ContextService {
  private readonly logger = new Logger(ContextService.name);

  constructor(
    @InjectModel(Context.name) private readonly contextModel: Model<ContextDocument>,
  ) {}

  /**
   * Los últimos pares de ESTE usuario, en orden cronológico ascendente
   * (el más viejo primero) para que se puedan replayar tal cual al modelo.
   */
  async getForUser(username: string): Promise<ContextPair[]> {
    const user = (username ?? '').trim();
    if (!user) return [];

    try {
      return await this.readRecent({ user }, MAX_PAIRS_PER_USER);
    } catch (err) {
      this.logger.warn(`No se pudo leer el contexto de ${user}: ${(err as Error)?.message}`);
      return [];
    }
  }

  /**
   * Los últimos pares de TODA la sala, para el modo compartido
   * (`ChatService.isSharedContextEnabled`). No reintroduce el problema de la
   * vieja cola global: `ChatService` replaya cada pregunta con el nombre de su
   * autor. Y como `save` sigue podando por usuario, nadie aporta más de
   * `MAX_PAIRS_PER_USER`: una persona insistente no barre a las demás.
   */
  async getShared(): Promise<ContextPair[]> {
    try {
      return await this.readRecent({}, MAX_SHARED_PAIRS);
    } catch (err) {
      this.logger.warn(`No se pudo leer el contexto compartido: ${(err as Error)?.message}`);
      return [];
    }
  }

  private async readRecent(filter: { user?: string }, limit: number): Promise<ContextPair[]> {
    const cutoff = new Date(Date.now() - MAX_AGE_MINUTES * 60_000);

    const rows = await this.contextModel
      .find({ ...filter, createdAt: { $gte: cutoff } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();

    // La consulta trae los más recientes primero; el replay los necesita al
    // revés, así que se invierte acá y no en el llamador.
    return rows.reverse().map((r) => ({
      question: r.question,
      answer: r.answer,
      user: r.user ?? '',
    }));
  }

  /** Guarda un par y poda el excedente DE ESE USUARIO. */
  async save(pair: ContextPair): Promise<void> {
    const user = (pair.user ?? '').trim();
    if (!user) return;

    try {
      await this.contextModel.create({
        question: pair.question,
        answer: pair.answer,
        user,
      });

      const overflow = await this.contextModel
        .find({ user })
        .sort({ createdAt: -1 })
        .skip(MAX_PAIRS_PER_USER)
        .select({ _id: 1 })
        .lean()
        .exec();

      if (overflow.length > 0) {
        await this.contextModel.deleteMany({ _id: { $in: overflow.map((d) => d._id) } });
      }
    } catch (err) {
      this.logger.warn(`No se pudo guardar el contexto de ${user}: ${(err as Error)?.message}`);
    }
  }
}
