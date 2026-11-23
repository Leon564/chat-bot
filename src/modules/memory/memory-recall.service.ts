import { Injectable } from '@nestjs/common';
import { BotMemoryDocument } from '../../common/schemas/bot-memory.schema';
import { MemoryStore, memoryUserKey } from './memory-store.service';
import { EmbeddingService, cosine } from './embedding.service';
import { addDays, formatEventDate, localDayKey } from './memory-time';
import { MemoryKind } from './memory.types';

export const MAX_RECALLED = 3;
/** Un recuerdo ya mostrado a esa persona no se repite en este tiempo… */
export const REPEAT_WINDOW_MS = 30 * 60_000;
/** …salvo que el mensaje lo nombre directamente (lo supere por este margen). */
export const DIRECT_MARGIN = 0.08;
/** Eventos que entran siempre: desde ayer hasta dentro de estos días. */
const EVENT_LOOKAHEAD_DAYS = 3;

const KIND_LABEL: Record<MemoryKind, string> = { event: 'evento', fact: 'dato', shared: 'compartido' };

export interface RecalledMemory {
  ref: string;
  id: string;
  kind: MemoryKind;
  text: string;
  eventDate?: string;
  eventTime?: string;
}

const normalizeWords = (text: string): Set<string> =>
  new Set(
    (text ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9ñ]+/)
      .filter(Boolean),
  );

/**
 * Decide qué recuerdos de una persona entran al prompt de este mensaje: los
 * eventos cercanos siempre, el resto sólo si se parecen en significado al
 * mensaje (o, sin embeddings, si comparten una palabra clave). Tope de 3 y sin
 * repetir en 30 min lo que ya se mostró.
 */
@Injectable()
export class MemoryRecallService {
  /** userKey → (id del recuerdo → cuándo se mostró). En memoria: un solo proceso. */
  private shown = new Map<string, Map<string, number>>();

  constructor(
    private readonly store: MemoryStore,
    private readonly embeddings: EmbeddingService,
  ) {}

  /** Para tests. */
  resetShown(): void {
    this.shown.clear();
  }

  async recall(
    username: string,
    text: string,
    now = new Date(),
    opts: { followUp?: string } = {},
  ): Promise<{ block: string; refs: Map<string, string> }> {
    const refs = new Map<string, string>();
    const active = await this.store.listActive(username, now);
    if (active.length === 0 && !opts.followUp) return { block: '', refs };

    const picked = active.length > 0 ? await this.pick(username, text, active, now) : [];
    const recalled: RecalledMemory[] = picked.map((m, i) => ({
      ref: `r${i + 1}`,
      id: String(m._id),
      kind: m.kind,
      text: m.text,
      eventDate: m.eventDate ?? undefined,
      eventTime: m.eventTime ?? undefined,
    }));
    for (const r of recalled) refs.set(r.ref, r.id);

    if (recalled.length === 0 && !opts.followUp) return { block: '', refs };

    const sensitive = new Set(picked.filter((m) => m.sensitive).map((m) => String(m._id)));
    const lines = [`[Recuerdos de ${username.trim()} — usalos sólo si vienen al caso; no los recites]`];
    for (const r of recalled) lines.push(`${r.ref} (${this.describe(r, sensitive.has(r.id))}): ${r.text}`);
    if (opts.followUp) lines.push(`Preguntale cómo le fue con: ${opts.followUp}`);

    if (picked.length > 0) {
      await this.store.markUsed(recalled.map((r) => r.id), now);
      const seen = this.shown.get(memoryUserKey(username)) ?? new Map<string, number>();
      for (const r of recalled) seen.set(r.id, now.getTime());
      this.shown.set(memoryUserKey(username), seen);
    }
    return { block: lines.join('\n'), refs };
  }

  private async pick(username: string, text: string, active: BotMemoryDocument[], now: Date): Promise<BotMemoryDocument[]> {
    const today = localDayKey(now);
    const from = addDays(today, -1);
    const to = addDays(today, EVENT_LOOKAHEAD_DAYS);
    // Un delicado no entra "porque sí" por estar cerca: sólo si el mensaje habla de eso.
    const isNear = (m: BotMemoryDocument) =>
      m.kind === 'event' && !m.sensitive && !!m.eventDate && m.eventDate >= from && m.eventDate <= to;

    const scores = await this.score(text, active);
    const threshold = scores.threshold;
    const seen = this.shown.get(memoryUserKey(username));
    const recentlyShown = (m: BotMemoryDocument) => {
      const at = seen?.get(String(m._id));
      return at !== undefined && now.getTime() - at < REPEAT_WINDOW_MS;
    };

    const candidates = active.filter((m) => {
      const s = scores.byId.get(String(m._id));
      const relevant = isNear(m) || (s !== undefined && s >= threshold);
      if (!relevant) return false;
      if (!recentlyShown(m)) return true;
      // Ya mostrado hace poco: sólo si el mensaje lo nombra directamente.
      return s !== undefined && scores.semantic && s >= threshold + DIRECT_MARGIN;
    });

    candidates.sort((a, b) => {
      const near = Number(isNear(b)) - Number(isNear(a));
      if (near !== 0) return near;
      if (isNear(a)) return (a.eventDate ?? '').localeCompare(b.eventDate ?? '');
      return (scores.byId.get(String(b._id)) ?? 0) - (scores.byId.get(String(a._id)) ?? 0);
    });
    return candidates.slice(0, MAX_RECALLED);
  }

  /** Parecido de cada recuerdo con el mensaje: coseno del mismo modelo, o palabras clave como piso. */
  private async score(
    text: string,
    active: BotMemoryDocument[],
  ): Promise<{ byId: Map<string, number>; threshold: number; semantic: boolean }> {
    const byId = new Map<string, number>();
    const query = await this.embeddings.embed([text], 'query');

    if (!query || query.vectors.length === 0) {
      const words = normalizeWords(text);
      for (const m of active) {
        if (m.keywords.some((k) => words.has(k))) byId.set(String(m._id), 1);
      }
      return { byId, threshold: 1, semantic: false };
    }

    const { model } = query;
    const qv = query.vectors[0];
    const missing = active.filter((m) => !m.embeddings.some((e) => e.model === model));
    if (missing.length > 0) {
      const vectors = await this.embeddings.embedWith(model, missing.map((m) => m.text), 'passage');
      if (vectors) {
        await Promise.all(
          missing.map((m, i) => {
            m.embeddings.push({ model, vector: vectors[i] });
            return this.store.setEmbedding(String(m._id), model, vectors[i]);
          }),
        );
      }
    }
    for (const m of active) {
      const v = m.embeddings.find((e) => e.model === model)?.vector;
      if (v) byId.set(String(m._id), cosine(qv, v));
    }
    return { byId, threshold: this.embeddings.thresholdFor(model), semantic: true };
  }

  private describe(r: RecalledMemory, sensitive: boolean): string {
    const parts = [KIND_LABEL[r.kind]];
    if (r.kind === 'event' && r.eventDate) parts[0] += `, ${formatEventDate(r.eventDate, r.eventTime)}`;
    if (sensitive) parts.push('delicado');
    return parts.join(', ');
  }
}
