import { Injectable, Logger } from '@nestjs/common';
import fetch from 'node-fetch';

export type AniListKind = 'manga' | 'manhwa' | 'manhua' | 'anime';

export interface AniListResult {
  id: number;
  url: string;
  kind: AniListKind;
  titleRomaji: string;
  titleEnglish: string | null;
  coverImage: string | null;
  bannerImage: string | null;
  score: number | null; // 0-100 (averageScore)
  status: string | null; // RELEASING, FINISHED, NOT_YET_RELEASED, CANCELLED, HIATUS
  chapters: number | null;
  volumes: number | null;
  episodes: number | null;
  genres: string[];
  description: string | null; // sin HTML, ya limpio
  startYear: number | null;
}

const ENDPOINT = 'https://graphql.anilist.co';

// Buscamos un único Media; si no coincide exactamente con el título, AniList
// igual hace fuzzy match contra romaji/english/native/synonyms.
const QUERY = `
  query ($search: String!, $type: MediaType!, $countryOfOrigin: CountryCode, $format_in: [MediaFormat]) {
    Media(search: $search, type: $type, countryOfOrigin: $countryOfOrigin, format_in: $format_in, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
      id
      siteUrl
      type
      format
      countryOfOrigin
      title { romaji english native }
      coverImage { large extraLarge }
      bannerImage
      averageScore
      status
      chapters
      volumes
      episodes
      genres
      description(asHtml: false)
      startDate { year }
    }
  }
`;

@Injectable()
export class AniListService {
  private readonly logger = new Logger(AniListService.name);

  static normalizeKind(raw: string): AniListKind | null {
    const v = (raw ?? '').trim().toLowerCase();
    if (v === 'manga') return 'manga';
    if (v === 'manhwa' || v === 'manwha') return 'manhwa';
    if (v === 'manhua') return 'manhua';
    if (v === 'anime') return 'anime';
    return null;
  }

  async search(kind: AniListKind, title: string): Promise<AniListResult | null> {
    const cleanTitle = (title ?? '').trim();
    if (!cleanTitle) return null;

    const variables = this.buildVariables(kind, cleanTitle);

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query: QUERY, variables }),
      });
    } catch (err) {
      this.logger.warn(`AniList network error: ${(err as Error).message}`);
      throw new Error('NETWORK');
    }

    if (res.status === 404) return null;
    if (res.status === 429) throw new Error('RATE_LIMIT');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.warn(`AniList HTTP ${res.status}: ${body.slice(0, 200)}`);
      throw new Error(`HTTP_${res.status}`);
    }

    const json = (await res.json()) as {
      data?: { Media?: any };
      errors?: { message: string; status?: number }[];
    };

    // AniList devuelve un error con status 404 dentro de `errors` cuando no
    // encuentra nada — no es un 4xx HTTP. Tratarlo como "sin resultado" en vez
    // de propagar excepción.
    if (json.errors?.length) {
      const notFound = json.errors.some((e) => e.status === 404 || /not found/i.test(e.message));
      if (notFound) return null;
      this.logger.warn(`AniList GraphQL error: ${JSON.stringify(json.errors).slice(0, 200)}`);
      throw new Error('GRAPHQL');
    }

    const media = json.data?.Media;
    if (!media) return null;

    return this.toResult(kind, media);
  }

  private buildVariables(kind: AniListKind, search: string): Record<string, any> {
    if (kind === 'anime') {
      return { search, type: 'ANIME' };
    }
    // Manga/manhwa/manhua: todos viven bajo type=MANGA en AniList, distinguidos
    // por countryOfOrigin. Manga incluye one-shots y novelas: filtramos a los
    // dos formatos más comunes para evitar light novels como primer resultado.
    const base: Record<string, any> = {
      search,
      type: 'MANGA',
      format_in: ['MANGA', 'ONE_SHOT'],
    };
    if (kind === 'manhwa') base.countryOfOrigin = 'KR';
    else if (kind === 'manhua') base.countryOfOrigin = 'CN';
    else base.countryOfOrigin = 'JP';
    return base;
  }

  private toResult(kind: AniListKind, m: any): AniListResult {
    return {
      id: m.id,
      url: m.siteUrl,
      kind,
      titleRomaji: m.title?.romaji ?? m.title?.native ?? '',
      titleEnglish: m.title?.english ?? null,
      coverImage: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
      bannerImage: m.bannerImage ?? null,
      score: typeof m.averageScore === 'number' ? m.averageScore : null,
      status: m.status ?? null,
      chapters: typeof m.chapters === 'number' ? m.chapters : null,
      volumes: typeof m.volumes === 'number' ? m.volumes : null,
      episodes: typeof m.episodes === 'number' ? m.episodes : null,
      genres: Array.isArray(m.genres) ? m.genres : [],
      description: this.cleanDescription(m.description),
      startYear: m.startDate?.year ?? null,
    };
  }

  // AniList ignora el flag asHtml:false a veces y devuelve <br> + entities.
  // Normalizamos a texto plano para que la tarjeta no salga con etiquetas.
  private cleanDescription(raw: string | null | undefined): string | null {
    if (!raw) return null;
    return raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(i|b|em|strong)>/gi, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim() || null;
  }
}
