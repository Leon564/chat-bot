import { Injectable, Logger } from '@nestjs/common';
import { GraphService } from './graph.service';
import { GraphNodeDocument } from '../../common/schemas/graph-node.schema';
import { ChatMessage } from '../chat-socket/chat-socket.service';

/** Las menciones no vienen como campo: llegan inline dentro del contenido. */
const MENTION_RE = /<@([^>\n\r]+)>/g;

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
}
