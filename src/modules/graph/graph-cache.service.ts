import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AniListResult } from '../anilist/anilist.service';
import { TrackMeta } from '../../common/interfaces';
import { GraphService } from './graph.service';
import { GraphNodeDocument } from '../../common/schemas/graph-node.schema';

/**
 * Días que una obra `RELEASING` (o cualquier estado que no sea `FINISHED`)
 * se sirve desde el grafo antes de considerarse vencida. Una obra en curso
 * puede sumar capítulos; una `FINISHED` no cambia más, así que esa nunca
 * vence (ver `isFresh`).
 */
export const WORK_TTL_DAYS = 7;

/**
 * Días que una pista ya subida se sirve desde el grafo antes de considerarse
 * vencida, medidos sobre `updatedAt` (que Mongoose mantiene solo). La key de
 * este caché es la query cruda del usuario, así que algo genérico como "pon
 * música de queen" quedaría ligado para siempre al primer video que YouTube
 * devolvió si no venciera nunca — antes de este caché cada pedido re-buscaba.
 * `updatedAt` sólo se mueve cuando `ingestTrack` escribe (un miss real que
 * pasó por el pipeline), nunca en una lectura de `findTrack` — así que un
 * acierto de caché no renueva su propia vigencia, igual que `cachedAt` en las
 * obras (ver el comentario de `WORK_TTL_DAYS`/ingestAniList).
 */
export const TRACK_TTL_DAYS = 30;

/** Los únicos cuatro tipos de obra que reconoce AniList. Cerrado a propósito. */
const VALID_KINDS: ReadonlySet<string> = new Set(['manga', 'manhwa', 'manhua', 'anime']);

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

  constructor(
    private readonly graph: GraphService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Interruptor de emergencia (`CACHE_ENABLED`, default `true`): en `false`
   * apaga por completo el lado de LECTURA del caché sin necesitar rollback.
   * Las escrituras (`saveTranslation`/`invalidateTrack`, y el ingest) no se
   * gatean acá — persistir no hace daño aunque nadie vaya a leerlo.
   */
  private isCacheEnabled(): boolean {
    return this.configService.get<boolean>('graph.cacheEnabled') ?? true;
  }

  /**
   * Busca una obra ya cacheada en el grafo. Devuelve `null` si no existe, si
   * el tipo no coincide, si venció, o si le faltan campos que la ficha
   * necesita — este último caso es el estado normal de los nodos que dejó la
   * Fase 1 (sin `titleRomaji`/`titleEnglish`/`sinopsisEs`): el camino normal
   * los va a completar, no hace falta tratarlo como error.
   *
   * El filtro por `kind` va DENTRO de la consulta a Mongo (vía
   * `resolveByAliasAndProp`), no como un chequeo posterior sobre el ganador
   * por peso — ver el comentario en `GraphService.resolveByAliasAndProp`
   * para el caso (obra duplicada como anime y manhwa) que eso rompía.
   */
  async findWork(kind: string, title: string): Promise<CachedWork | null> {
    if (!this.isCacheEnabled()) return null;

    try {
      const normalizedKind = (kind ?? '').toLowerCase();
      if (!this.isValidKind(normalizedKind)) return null;

      const node = await this.graph.resolveByAliasAndProp(title, ['work'], 'kind', normalizedKind);
      if (!node) return null;

      const props = node.props ?? {};
      // Defensa extra: si por lo que sea el dato guardado no fuera uno de
      // los 4 literales válidos (p. ej. "Manga" con mayúscula por un bug de
      // escritura), tratarlo como miss en vez de castearlo ciegamente — un
      // `kind` corrupto hace que `formatAniListCard` busque una key que no
      // existe en su mapa de labels y renderice "**undefined**".
      if (!this.isValidKind(props.kind)) return null;

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
   * permanencia, no un vencimiento. Además vence a los `TRACK_TTL_DAYS` sobre
   * `updatedAt` (ver el comentario de la constante).
   */
  async findTrack(query: string): Promise<TrackMeta | null> {
    if (!this.isCacheEnabled()) return null;

    try {
      const node = await this.graph.findNode('track', query);
      if (!node) return null;

      const props = node.props ?? {};
      if (props.uploadPermanent !== true) return null;
      if (typeof props.uploadUrl !== 'string' || !props.uploadUrl) return null;
      if (!this.isTrackFresh(node)) return null;

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

  /**
   * Vence a los `TRACK_TTL_DAYS` sobre `updatedAt`. Sin timestamp confiable
   * no hay forma de confirmar vigencia, así que se trata como vencido —
   * mismo criterio conservador que `isFresh` para obras.
   */
  private isTrackFresh(node: GraphNodeDocument): boolean {
    const updatedAt = (node as unknown as { updatedAt?: Date | string }).updatedAt;
    if (!updatedAt) return false;

    const updatedAtMs = new Date(updatedAt).getTime();
    if (Number.isNaN(updatedAtMs)) return false;

    const ageMs = Date.now() - updatedAtMs;
    return ageMs < TRACK_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  /** Valida contra los 4 literales que reconoce AniList; cualquier otra cosa se trata como miss. */
  private isValidKind(value: unknown): value is AniListResult['kind'] {
    return typeof value === 'string' && VALID_KINDS.has(value);
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
