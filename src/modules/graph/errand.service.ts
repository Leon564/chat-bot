import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Errand, ErrandDocument } from '../../common/schemas/errand.schema';
import { GraphService } from './graph.service';

/**
 * Recados pendientes por autor, sumando TODOS sus destinatarios. Es global a
 * propósito: si fuera por destinatario, un autor podría encolar 3 recados a
 * cada una de veinte personas y el tope no frenaría nada. Cada recado
 * entregado cuesta una llamada al modelo que nadie pidió, así que este número
 * es el techo real del gasto que una sola persona puede provocar.
 */
export const MAX_PENDING_PER_AUTHOR = 3;

/** Recados pendientes que puede acumular una persona, sumando todos los autores. */
export const MAX_PENDING_PER_TARGET = 5;

export const ERRAND_TTL_DAYS = 7;
export const MAX_ERRAND_TEXT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CreateErrandResult =
  | 'ok'
  | 'autor_lleno'
  | 'destino_lleno'
  | 'usuario_desconocido'
  | 'invalido';

@Injectable()
export class ErrandService {
  private readonly logger = new Logger(ErrandService.name);

  constructor(
    @InjectModel(Errand.name) private readonly errandModel: Model<ErrandDocument>,
    private readonly graph: GraphService,
  ) {}

  async create(fromUser: string, forUser: string, text: string): Promise<CreateErrandResult> {
    try {
      const clean = (text ?? '').trim();
      if (!clean || clean.length > MAX_ERRAND_TEXT) return 'invalido';

      // Tanto el autor como el destinatario tienen que existir. Un recado no
      // puede crear gente en el grafo, misma regla que `ingestFactAbout`.
      const [autor, destino] = await Promise.all([
        this.graph.findNode('user', fromUser),
        this.graph.findNode('user', forUser),
      ]);
      if (!autor || !destino) return 'usuario_desconocido';
      if (autor.key === destino.key) return 'invalido';

      const ahora = new Date();
      const pendiente = { deliveredAt: null, expiresAt: { $gt: ahora } };

      const [delAutor, delDestino] = await Promise.all([
        this.errandModel.countDocuments({ fromUser: autor.key, ...pendiente }),
        this.errandModel.countDocuments({ forUser: destino.key, ...pendiente }),
      ]);
      if (delAutor >= MAX_PENDING_PER_AUTHOR) return 'autor_lleno';
      if (delDestino >= MAX_PENDING_PER_TARGET) return 'destino_lleno';

      await this.errandModel.create({
        fromUser: autor.key,
        fromLabel: autor.label || autor.key,
        forUser: destino.key,
        text: clean,
        expiresAt: new Date(ahora.getTime() + ERRAND_TTL_DAYS * DAY_MS),
        deliveredAt: null,
      });
      return 'ok';
    } catch (err) {
      this.logger.warn(`No se pudo crear el recado: ${(err as Error)?.message}`);
      return 'invalido';
    }
  }

  /**
   * Toma el recado pendiente más viejo para `forUser` y lo marca entregado
   * **en la misma operación**.
   *
   * `findOneAndUpdate` atómico, no un `find` seguido de un `update`: el bot
   * procesa mensajes de forma asíncrona, así que dos mensajes seguidos de la
   * misma persona pueden entrar acá a la vez y ambos leerían el mismo
   * documento pendiente. El resultado sería el mismo recado entregado dos
   * veces.
   *
   * Se marca ANTES de que el llamador hable, no después: si la llamada al
   * modelo falla, se pierde un recado en vez de reintentarlo para siempre en
   * cada mensaje de esa persona. El llamador compensa mandando un texto fijo
   * como último recurso (ver `BotService.deliverPendingErrand`).
   */
  async claimNext(forUser: string): Promise<{ fromLabel: string; text: string } | null> {
    try {
      const key = this.graph.normalizeUserKey(forUser);
      if (!key) return null;

      const doc = await this.errandModel
        .findOneAndUpdate(
          { forUser: key, deliveredAt: null, expiresAt: { $gt: new Date() } },
          { $set: { deliveredAt: new Date() } },
          { sort: { createdAt: 1 }, new: true },
        )
        .exec();

      return doc ? { fromLabel: doc.fromLabel, text: doc.text } : null;
    } catch (err) {
      this.logger.warn(`No se pudo leer recados de ${forUser}: ${(err as Error)?.message}`);
      return null;
    }
  }
}
