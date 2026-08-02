import { Injectable, Logger } from '@nestjs/common';
import { AniListResult } from '../anilist/anilist.service';
import { TrackMeta } from '../../common/interfaces';
import { GraphService } from './graph.service';

/**
 * Días que una obra `RELEASING` (o cualquier estado que no sea `FINISHED`)
 * se sirve desde el grafo antes de considerarse vencida. Una obra en curso
 * puede sumar capítulos; una `FINISHED` no cambia más, así que esa nunca
 * vence (ver `isFresh`).
 */
export const WORK_TTL_DAYS = 7;

export interface CachedWork {
  result: AniListResult;
  sinopsisEs: string | null;
}

/**
 * El lado de lectura del grafo de conocimiento: evita repetir llamadas a
 * AniList, traducciones y subidas de audio ya hechas.
 *
 * Principio que gobierna cada método acá: un caché que sirve datos malos es
 * peor que no tener caché. Todo miss es silencioso y barato — nodo
 * inexistente, campos faltantes, TTL vencido, o Mongo caído — siempre
 * devuelve `null` (o no hace nada, en los métodos de escritura) y deja que
 * el llamador siga el camino normal. Ninguna excepción se propaga desde acá.
 */
@Injectable()
export class GraphCacheService {
  private readonly logger = new Logger(GraphCacheService.name);

  constructor(private readonly graph: GraphService) {}

  /**
   * Busca una obra ya cacheada en el grafo. Devuelve `null` si no existe, si
   * el tipo no coincide, si venció, o si le faltan campos que la ficha
   * necesita — este último caso es el estado normal de los nodos que dejó la
   * Fase 1 (sin `titleRomaji`/`titleEnglish`/`sinopsisEs`): el camino normal
   * los va a completar, no hace falta tratarlo como error.
   */
  async findWork(kind: string, title: string): Promise<CachedWork | null> {
    try {
      const node = await this.graph.resolveByAlias(title, ['work']);
      if (!node) return null;

      const props = node.props ?? {};
      const nodeKind = typeof props.kind === 'string' ? props.kind.toLowerCase() : null;
      if (nodeKind !== (kind ?? '').toLowerCase()) return null;

      if (!this.isFresh(props)) return null;
      if (!this.hasRequiredFields(props)) return null;

      return {
        result: this.toAniListResult(props),
        sinopsisEs: typeof props.sinopsisEs === 'string' ? props.sinopsisEs : null,
      };
    } catch (err) {
      this.logger.warn(`findWork falló, se sigue sin cache: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Guarda la traducción de la sinopsis en el nodo ya existente. No crea
   * nodos nuevos: si `saveTranslation` corre antes de que la obra haya sido
   * ingresada al grafo por otro camino, no hay nada que traducir todavía.
   */
  async saveTranslation(anilistId: number, sinopsisEs: string): Promise<void> {
    try {
      const node = await this.graph.findNode('work', `anilist:${anilistId}`);
      if (!node) return;

      await this.graph.upsertNode({
        type: 'work',
        key: node.key,
        label: node.label,
        props: { sinopsisEs },
      });
    } catch (err) {
      this.logger.warn(`saveTranslation falló: ${(err as Error).message}`);
    }
  }

  /**
   * Busca una pista ya subida. Sólo sirve subidas permanentes
   * (`props.uploadPermanent === true`) — `props.expiresAt` en los nodos
   * `track` siempre es `null`, así que la frescura real la marca el flag de
   * permanencia, no un vencimiento.
   */
  async findTrack(query: string): Promise<TrackMeta | null> {
    try {
      const node = await this.graph.findNode('track', query);
      if (!node) return null;

      const props = node.props ?? {};
      if (props.uploadPermanent !== true) return null;
      if (typeof props.uploadUrl !== 'string' || !props.uploadUrl) return null;

      return {
        title: typeof props.title === 'string' ? props.title : node.label,
        artist: typeof props.artist === 'string' ? props.artist : null,
        thumb: typeof props.thumb === 'string' ? props.thumb : null,
        youtubeUrl: typeof props.youtubeUrl === 'string' ? props.youtubeUrl : null,
        uploadUrl: props.uploadUrl,
        uploadService: typeof props.uploadService === 'string' ? props.uploadService : '',
      };
    } catch (err) {
      this.logger.warn(`findTrack falló, se sigue sin cache: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Invalida la URL de una pista sin borrar el nodo — las aristas
   * `requested` y el vínculo con el artista siguen siendo válidos, sólo el
   * archivo subido murió (p. ej. litterbox venció).
   */
  async invalidateTrack(query: string): Promise<void> {
    try {
      const node = await this.graph.findNode('track', query);
      if (!node) return;

      await this.graph.upsertNode({
        type: 'track',
        key: node.key,
        label: node.label,
        props: { uploadUrl: null },
      });
    } catch (err) {
      this.logger.warn(`invalidateTrack falló: ${(err as Error).message}`);
    }
  }

  /** `FINISHED` no vence nunca; cualquier otro estado vence a los `WORK_TTL_DAYS` días. */
  private isFresh(props: Record<string, unknown>): boolean {
    if (props.status === 'FINISHED') return true;

    const cachedAt = props.cachedAt;
    if (!(cachedAt instanceof Date) && typeof cachedAt !== 'string') return false;

    const cachedAtMs = new Date(cachedAt as string | Date).getTime();
    if (Number.isNaN(cachedAtMs)) return false;

    const ageMs = Date.now() - cachedAtMs;
    return ageMs < WORK_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  /** Campos que la tarjeta necesita para renderizarse; ausentes en nodos viejos de la Fase 1. */
  private hasRequiredFields(props: Record<string, unknown>): boolean {
    return (
      typeof props.anilistId === 'number' &&
      typeof props.kind === 'string' &&
      typeof props.url === 'string' &&
      typeof props.titleRomaji === 'string' &&
      Array.isArray(props.genres)
    );
  }

  private toAniListResult(props: Record<string, unknown>): AniListResult {
    return {
      id: props.anilistId as number,
      url: props.url as string,
      kind: props.kind as AniListResult['kind'],
      titleRomaji: props.titleRomaji as string,
      titleEnglish: typeof props.titleEnglish === 'string' ? props.titleEnglish : null,
      coverImage: typeof props.coverImage === 'string' ? props.coverImage : null,
      bannerImage: null,
      score: typeof props.score === 'number' ? props.score : null,
      status: typeof props.status === 'string' ? props.status : null,
      chapters: typeof props.chapters === 'number' ? props.chapters : null,
      volumes: typeof props.volumes === 'number' ? props.volumes : null,
      episodes: typeof props.episodes === 'number' ? props.episodes : null,
      genres: props.genres as string[],
      description: null,
      startYear: typeof props.startYear === 'number' ? props.startYear : null,
    };
  }
}
