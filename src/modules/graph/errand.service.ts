import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Errand, ErrandDocument } from '../../common/schemas/errand.schema';
import { GraphNodeDocument } from '../../common/schemas/graph-node.schema';
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

  /**
   * Cola FIFO en memoria que serializa la sección crítica de `create`
   * (conteo de pendientes + inserción) DENTRO de este proceso.
   *
   * Revisión de código (post-entrega, CRITICAL): sin esto, `create` era un
   * count-then-insert con ventana TOCTOU — dos (o seis) llamadas
   * concurrentes al mismo autor leían el mismo conteo (0, 1, 2...) ANTES de
   * que ninguna hubiera insertado todavía, y las seis pasaban el tope.
   * Medido: `Promise.all` de 6 `create('leon', 'lyna', ...)` con
   * `MAX_PENDING_PER_AUTHOR = 3` insertaba 5 (ver
   * `errand.service.spec.ts`, test "seis create() concurrentes..."). El
   * disparador real es `chat.service.ts`, que emite un `create` por cada
   * `SAVE_ERRAND` de una misma respuesta del modelo SIN esperarlos entre
   * sí (`void ...create(...).catch(...)` dentro de un loop) — el modelo
   * puede emitir varios verbos en una sola respuesta, así que esto no
   * necesita mala fe, alcanza con que conteste distraído.
   *
   * Por qué una cola en memoria y no un `findOneAndUpdate` atómico (como
   * `claimNext`): acá el tope es sobre un CONTEO de documentos —y son DOS
   * conteos independientes, por autor y por destinatario— no sobre un único
   * documento existente. No hay una operación atómica nativa de Mongo que
   * exprese "insertá sólo si hay menos de N documentos que cumplen este
   * filtro" sin mantener un contador aparte (un campo `pendingCount` en el
   * nodo `user`) que además habría que decrementar en la entrega
   * (`claimNext`) Y en el vencimiento — introduce una fuente nueva de
   * desincronización (contador vs. colección real) para resolver un
   * problema que una cola en memoria resuelve sin ese riesgo.
   *
   * Por qué ES suficiente una cola en memoria y no hace falta ir a Mongo:
   * el bot corre como un único proceso Node (`bot/`, sin Redis ni clúster —
   * ver el `CLAUDE.md` del repo), así que no hay una segunda instancia con
   * la que esta cola tenga que coordinarse. Esto cierra TANTO el caso de
   * una sola respuesta con varios `SAVE_ERRAND` (secuencial per definición,
   * la cola ni siquiera tiene que esperar) COMO el de dos llamadas
   * genuinamente concurrentes disparadas por dos mensajes distintos
   * procesados a la vez por este mismo proceso — los dos casos que pidió la
   * revisión. Lo que NO cubre (documentado, no un descuido): si algún día
   * el bot corriera en más de un proceso/instancia a la vez, esta cola deja
   * de ser suficiente y haría falta el mecanismo de Mongo de arriba.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectModel(Errand.name) private readonly errandModel: Model<ErrandDocument>,
    private readonly graph: GraphService,
  ) {}

  /** Encola `fn` para que corra después de que termine (bien o mal) todo lo encolado antes. */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // La cola avanza pase lo que pase con `run` — un `create` que falla no
    // puede dejar bloqueada la cola para siempre.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async create(fromUser: string, forUser: string, text: string): Promise<CreateErrandResult> {
    try {
      const clean = (text ?? '').trim();
      if (!clean || clean.length > MAX_ERRAND_TEXT) return this.rechazo('invalido', fromUser, forUser);

      // Tanto el autor como el destinatario tienen que existir. Un recado no
      // puede crear gente en el grafo, misma regla que `ingestFactAbout`.
      const [autor, destino] = await Promise.all([
        this.graph.findNode('user', fromUser),
        this.graph.findNode('user', forUser),
      ]);
      if (!autor || !destino) return this.rechazo('usuario_desconocido', fromUser, forUser);
      if (autor.key === destino.key) return this.rechazo('invalido', fromUser, forUser);

      // Sección crítica serializada — ver el comentario de `queue` arriba.
      const resultado = await this.runExclusive(() => this.createLocked(autor, destino, clean));
      if (resultado !== 'ok') this.rechazo(resultado, fromUser, forUser);
      return resultado;
    } catch (err) {
      this.logger.warn(`No se pudo crear el recado de ${fromUser} para ${forUser}: ${(err as Error)?.message}`);
      return 'invalido';
    }
  }

  /** Cuenta los pendientes de autor/destinatario e inserta si hay cupo en ambos. Corre SIEMPRE serializado (ver `queue`). */
  private async createLocked(
    autor: GraphNodeDocument,
    destino: GraphNodeDocument,
    clean: string,
  ): Promise<CreateErrandResult> {
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
  }

  /**
   * Revisión de código (Important): antes, cualquier rechazo que NO fuera
   * una excepción (autor_lleno, destino_lleno, usuario_desconocido,
   * inválido) era invisible — el modelo ya le contestó al usuario "dale, se
   * lo digo" y el recado simplemente no queda guardado, sin una sola línea
   * de log. Con un tope de 3 por autor esto va a pasar seguido; sin rastro
   * es indepurable. Un `warn` por rama de rechazo, sin bloquear el flujo.
   */
  private rechazo(resultado: CreateErrandResult, fromUser: string, forUser: string): CreateErrandResult {
    this.logger.warn(`Recado rechazado (${resultado}): ${fromUser} -> ${forUser}`);
    return resultado;
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
   *
   * `sort: { createdAt: 1, _id: 1 }` — el desempate por `_id` (Minor de la
   * revisión de código) importa porque dos recados creados en el mismo
   * milisegundo tienen `createdAt` idéntico y, sin un segundo criterio, el
   * orden entre ellos queda indefinido — justo lo que hace el test "devuelve
   * el más viejo", que los crea uno tras otro sin esperar un tick de reloj.
   * `_id` de Mongo es monótono creciente por inserción, así que desempata de
   * forma estable en el mismo orden en que se crearon.
   */
  async claimNext(forUser: string): Promise<{ fromLabel: string; text: string } | null> {
    try {
      const key = this.graph.normalizeUserKey(forUser);
      if (!key) return null;

      const doc = await this.errandModel
        .findOneAndUpdate(
          { forUser: key, deliveredAt: null, expiresAt: { $gt: new Date() } },
          { $set: { deliveredAt: new Date() } },
          { sort: { createdAt: 1, _id: 1 }, new: true },
        )
        .exec();

      return doc ? { fromLabel: doc.fromLabel, text: doc.text } : null;
    } catch (err) {
      this.logger.warn(`No se pudo leer recados de ${forUser}: ${(err as Error)?.message}`);
      return null;
    }
  }
}
