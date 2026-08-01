import { Injectable, Logger } from '@nestjs/common';
import { GraphService } from './graph.service';
import { GraphNodeDocument } from '../../common/schemas/graph-node.schema';
import { ChatMessage } from '../chat-socket/chat-socket.service';
import { AniListResult } from '../anilist/anilist.service';

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

/**
 * Traduce eventos del bot a escrituras en el grafo. Todo es best-effort: una
 * falla acá se loguea y se sigue. Perder una arista nunca justifica perder
 * una respuesta al usuario.
 */
@Injectable()
export class GraphIngestService {
  private readonly logger = new Logger(GraphIngestService.name);

  constructor(private readonly graph: GraphService) {}

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

      for (const match of (msg.content ?? '').matchAll(MENTION_RE)) {
        const name = match[1].trim();
        if (name) targets.add(name);
      }
      if (msg.replyTo?.authorUsername) targets.add(msg.replyTo.authorUsername.trim());

      const authorKey = this.graph.normalizeKey(msg.authorUsername);

      for (const target of targets) {
        if (this.graph.normalizeKey(target) === authorKey) continue;

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
   */
  async ingestAniList(username: string, result: AniListResult, rawQuery: string): Promise<void> {
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
          cachedAt: new Date(),
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
}
