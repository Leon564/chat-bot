import { Injectable, Logger } from '@nestjs/common';
import { GraphService } from './graph.service';
import { GraphNodeDocument } from '../../common/schemas/graph-node.schema';
import { EdgeType, EdgeSource } from '../../common/schemas/graph-edge.schema';
import { ChatMessage } from '../chat-socket/chat-socket.service';
import { AniListResult } from '../anilist/anilist.service';
import { TrackMeta } from '../../common/interfaces';
import { UtilsService } from '../../common/utils/utils.service';

/** Las menciones no vienen como campo: llegan inline dentro del contenido. */
const MENTION_RE = /<@([^>\n\r]+)>/g;

/**
 * Los 18 géneros oficiales de AniList con su traducción. Duplica el mapa de
 * formatAniListCard a propósito: allá es presentación efímera, acá es el
 * label persistido del nodo. Un género no mapeado se guarda en inglés.
 */
const GENRE_ES: Record<string, string> = {
  Action: 'Acción',
  Adventure: 'Aventura',
  Comedy: 'Comedia',
  Drama: 'Drama',
  Ecchi: 'Ecchi',
  Fantasy: 'Fantasía',
  Hentai: 'Hentai',
  Horror: 'Terror',
  'Mahou Shoujo': 'Mahou Shoujo',
  Mecha: 'Mecha',
  Music: 'Música',
  Mystery: 'Misterio',
  Psychological: 'Psicológico',
  Romance: 'Romance',
  'Sci-Fi': 'Ciencia ficción',
  'Slice of Life': 'Slice of Life',
  Sports: 'Deportes',
  Supernatural: 'Sobrenatural',
  Thriller: 'Suspenso',
};

/** Servicios cuyas URLs no expiran. Litterbox sí expira (LITTERBOX_EXPIRY). */
const PERMANENT_UPLOADS = ['catbox', 'filegarden'];

/**
 * Enum cerrado de relaciones que un `SAVE_FACT` puede emitir (Task 4, fase
 * 4b). Cualquier otro valor se descarta en `ingestFact` — es la defensa
 * contra que un usuario plante una relación arbitraria en el grafo; no hay
 * lista de strings que sanitizar porque no hay relación inventada que pase
 * esta validación.
 *
 * Exportada (ronda de corrección 2, Task 5) para que `chat.service.ts`
 * reconozca una línea `usuario|relación|objeto` dentro del resumen por la
 * MISMA lista que valida `ingestFact`, en vez de mantener una copia aparte
 * que podría desincronizarse si el enum cambia.
 */
export const FACT_RELATIONS: EdgeType[] = ['likes', 'dislikes', 'asked_about'];

/** Largo mínimo del objeto de un hecho ya sanitizado. Por debajo de esto no vale la pena persistirlo. */
const FACT_OBJECT_MIN_LEN = 3;

/**
 * Traduce eventos del bot a escrituras en el grafo. Todo es best-effort: una
 * falla acá se loguea y se sigue. Perder una arista nunca justifica perder
 * una respuesta al usuario.
 */
@Injectable()
export class GraphIngestService {
  private readonly logger = new Logger(GraphIngestService.name);

  constructor(
    private readonly graph: GraphService,
    private readonly utilsService: UtilsService,
  ) {}

  /** Crea o refresca el nodo de un usuario. */
  async touchUser(username: string): Promise<GraphNodeDocument | null> {
    const clean = (username ?? '').trim();
    if (!clean) return null;

    return this.graph.upsertNode({
      type: 'user',
      key: clean,
      label: clean,
      props: { lastMessageAt: new Date() },
      bumpWeight: true,
    });
  }

  /**
   * Registra al autor y sus interacciones sociales. Se llama para TODOS los
   * mensajes, no solo los dirigidos al bot — por eso engancha junto a
   * saveLog, antes del filtro de menciones del dispatcher.
   */
  async ingestSocial(msg: ChatMessage): Promise<void> {
    try {
      const author = await this.touchUser(msg.authorUsername);
      if (!author) return;

      // Los stickers no llevan texto real; sus menciones serían ruido.
      if (msg.type === 'sticker') return;

      const targets = new Set<string>();

      // Revisión final (Important #4): `MENTION_RE` acepta cualquier cosa
      // hasta el `>` — sin pasarlo por `sanitizeMemoryContent` (mismo
      // criterio que ya usa `ingestFact` para el objeto de un hecho) el
      // nombre mencionado se persistía tal cual en un nodo `user`, que
      // alimenta aristas `interacts_with` — uno de los tipos que
      // `GraphContextService` lee para el prompt. `minLen: 1` porque un
      // username real puede ser más corto que el mínimo de 5 que usa
      // `ingestFact` para el objeto de un hecho.
      for (const match of (msg.content ?? '').matchAll(MENTION_RE)) {
        const name = this.utilsService.sanitizeMemoryContent(match[1].trim(), { minLen: 1 });
        if (name) targets.add(name);
      }
      // `replyTo.authorUsername` no viene del texto libre del mensaje: es el
      // snapshot que el backend ya resolvió contra un mensaje/autor real al
      // armar la respuesta — a diferencia de la mención, no hace falta
      // sanitizarlo de nuevo acá.
      if (msg.replyTo?.authorUsername) targets.add(msg.replyTo.authorUsername.trim());

      // `normalizeUserKey`, no `normalizeKey`: el objetivo mencionado es una
      // persona, y la identidad de personas sigue la regla del backend
      // (sensible a acentos), no la de obras/temas (insensible). Con
      // `normalizeKey` acá, "Jose" y "José" -dos cuentas distintas para el
      // backend- se trataban como auto-mención y se perdía la arista social.
      const authorKey = this.graph.normalizeUserKey(msg.authorUsername);

      for (const target of targets) {
        if (this.graph.normalizeUserKey(target) === authorKey) continue;

        const node = await this.graph.upsertNode({ type: 'user', key: target, label: target });
        if (!node) continue;

        // Bidireccional: dos aristas dirigidas. Que A hable con B implica que
        // B es interlocutor de A y viceversa.
        await this.graph.upsertEdge({ from: author._id, to: node._id, type: 'interacts_with', source: 'signal' });
        await this.graph.upsertEdge({ from: node._id, to: author._id, type: 'interacts_with', source: 'signal' });
      }
    } catch (err) {
      this.logger.warn(`Ingesta social falló: ${(err as Error)?.message}`);
    }
  }

  /**
   * Persiste una ficha de AniList ya resuelta. La ficha completa va a props
   * para que la fase 4 pueda servirla sin volver a pegarle a la API ni
   * re-traducir la sinopsis. Los géneros se guardan TODOS, no solo los 5 que
   * muestra la tarjeta.
   *
   * `options.refreshCache` (default `true`) controla si esta llamada escribe
   * `cachedAt`. Se llama a este método también en un acierto de caché (para
   * mantener viva la arista `asked_about`), y ahí hay que pasar `false`: si
   * `cachedAt` se renovara en cada acierto, una obra `RELEASING` preguntada
   * cada semana nunca volvería a vencer — el TTL sólo expiraría las entradas
   * frías, nunca las calientes, que son justo las que cambian de estado.
   * Sólo el camino que realmente habló con AniList (miss, o el "miss
   * parcial" de una traducción faltante) debe renovar la fecha.
   */
  async ingestAniList(
    username: string,
    result: AniListResult,
    rawQuery: string,
    options: { refreshCache?: boolean } = {},
  ): Promise<void> {
    const refreshCache = options.refreshCache ?? true;

    try {
      const user = await this.touchUser(username);
      if (!user) return;

      const label = result.titleEnglish || result.titleRomaji;
      const aliases = [result.titleRomaji, result.titleEnglish ?? '', rawQuery].filter(
        (a) => a && a.trim().length > 0,
      );

      const work = await this.graph.upsertNode({
        type: 'work',
        key: `anilist:${result.id}`,
        label,
        aliases,
        props: {
          anilistId: result.id,
          kind: result.kind,
          url: result.url,
          coverImage: result.coverImage,
          score: result.score,
          status: result.status,
          chapters: result.chapters,
          volumes: result.volumes,
          episodes: result.episodes,
          startYear: result.startYear,
          genres: result.genres,
          titleRomaji: result.titleRomaji,
          titleEnglish: result.titleEnglish,
          ...(refreshCache ? { cachedAt: new Date() } : {}),
        },
        bumpWeight: true,
      });
      if (!work) return;

      await this.graph.upsertEdge({
        from: user._id,
        to: work._id,
        type: 'asked_about',
        source: 'signal',
      });

      for (const genre of result.genres) {
        const node = await this.graph.upsertNode({
          type: 'genre',
          key: genre,
          label: GENRE_ES[genre] ?? genre,
        });
        if (!node) continue;
        await this.graph.upsertEdge({
          from: work._id,
          to: node._id,
          type: 'has_genre',
          source: 'signal',
        });
      }
    } catch (err) {
      this.logger.warn(`Ingesta de AniList falló: ${(err as Error)?.message}`);
    }
  }

  /**
   * Persiste una pista ya resuelta y subida. El `uploadUrl` en props es lo
   * que permitirá (fase 4) responder un pedido repetido sin entrar a la cola:
   * hoy cada pedido re-busca, re-descarga, re-transcodifica y re-sube.
   */
  async ingestTrack(username: string, query: string, track: TrackMeta): Promise<void> {
    try {
      const user = await this.touchUser(username);
      if (!user) return;

      const node = await this.graph.upsertNode({
        type: 'track',
        key: query,
        label: track.title || query,
        aliases: [track.title].filter((a) => a && a.trim().length > 0),
        props: {
          title: track.title,
          artist: track.artist,
          thumb: track.thumb,
          youtubeUrl: track.youtubeUrl,
          uploadUrl: track.uploadUrl,
          uploadService: track.uploadService,
          // Esta fase solo registra. Con un servicio permanente el vencimiento
          // es null para siempre; con litterbox lo calcula la fase 4 desde
          // LITTERBOX_EXPIRY, que es quien va a leer el caché. Guardar acá una
          // fecha que nadie consume todavía sería inventar semántica.
          expiresAt: null,
          uploadPermanent: PERMANENT_UPLOADS.includes(track.uploadService),
        },
        bumpWeight: true,
      });
      if (!node) return;

      await this.graph.upsertEdge({
        from: user._id,
        to: node._id,
        type: 'requested',
        source: 'signal',
      });

      if (track.artist && track.artist.trim()) {
        const artist = await this.graph.upsertNode({
          type: 'artist',
          key: track.artist,
          label: track.artist.trim(),
        });
        if (artist) {
          await this.graph.upsertEdge({
            from: node._id,
            to: artist._id,
            type: 'by_artist',
            source: 'signal',
          });
        }
      }
    } catch (err) {
      this.logger.warn(`Ingesta de música falló: ${(err as Error)?.message}`);
    }
  }

  /**
   * Persiste un hecho `SAVE_FACT(relación, objeto)` (Task 4, fase 4b). El
   * sujeto siempre es `username` — nunca se lee del texto del modelo, así
   * que no hay forma de que un usuario le haga escribir un hecho sobre otra
   * persona.
   *
   * Dos validaciones cierran la puerta a que un usuario plante contenido
   * arbitrario en el grafo:
   *   - `relation` tiene que ser una de `FACT_RELATIONS` (enum cerrado, sin
   *     lista de patrones que mantener).
   *   - `object` pasa por `sanitizeMemoryContent` (misma limpieza que usaba
   *     el memory.json legacy) y se descarta si queda vacío o demasiado
   *     corto.
   *
   * El objeto se intenta resolver primero contra un nodo `work`/`genre`/
   * `artist` ya conocido (vía alias) para no duplicar "Attack on Titan" como
   * un `topic` suelto cuando ya existe como `work` desde AniList. Si no
   * resuelve, se crea (o refuerza) un nodo `topic` con el texto tal cual.
   *
   * `source` (default `'fact'`) distingue un hecho capturado en vivo vía
   * `SAVE_FACT` de uno extraído en lote del resumen (Task 5, fase 4b, que
   * pasa `'batch'`). No cambia ninguna validación: `upsertEdge` sólo escribe
   * `source` en `$setOnInsert`, así que una arista ya existente nunca se
   * degrada porque el lote la vuelva a proponer.
   */
  async ingestFact(
    username: string,
    relation: string,
    object: string,
    source: EdgeSource = 'fact',
  ): Promise<void> {
    try {
      if (!FACT_RELATIONS.includes(relation as EdgeType)) return;

      const cleanObject = this.utilsService.sanitizeMemoryContent(object, {
        minLen: FACT_OBJECT_MIN_LEN,
      });
      if (!cleanObject || cleanObject.length < FACT_OBJECT_MIN_LEN) return;

      const user = await this.touchUser(username);
      if (!user) return;

      const resolved = await this.graph.resolveByAlias(cleanObject, ['work', 'genre', 'artist']);
      const target =
        resolved ??
        (await this.graph.upsertNode({
          type: 'topic',
          key: cleanObject,
          label: cleanObject,
        }));
      if (!target) return;

      await this.graph.upsertEdge({
        from: user._id,
        to: target._id,
        type: relation as EdgeType,
        source,
      });
    } catch (err) {
      this.logger.warn(`Ingesta de hecho falló: ${(err as Error)?.message}`);
    }
  }
}
