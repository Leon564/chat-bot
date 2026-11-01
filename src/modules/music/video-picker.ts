/**
 * Elección del resultado de YouTube a descargar. Antes se tomaba siempre
 * `videos[0]` y, si pasaba el límite de duración, el pedido moría con
 * "demasiado largo" aunque el segundo resultado fuera la misma canción en
 * versión corta. Además el primer resultado suele ser el videoclip oficial,
 * que trae intros, escenas habladas o silencios largos al principio — para
 * un pedido de música es mejor el audio oficial, el "Artista - Topic" o un
 * lyric video.
 *
 * Todo acá es puro (sin red, sin config) para poder testearlo directo.
 */

export interface PickOptions {
  /** Límite en minutos; los resultados que lo superan se descartan. */
  maxMinutes: number;
  /** true para pedidos de audio: prioriza audio oficial / lyrics sobre el videoclip. */
  preferAudio: boolean;
}

export interface PickResult {
  /** El resultado elegido, o null si ninguno entra en el límite. */
  video: any | null;
  /**
   * Cuando `video` es null porque todo era demasiado largo: el primer
   * resultado relevante, para armar el mensaje de error con su duración.
   */
  tooLong: any | null;
}

/**
 * Cuánto tiene que cubrir de la búsqueda un resultado que no es el primero
 * para considerarse "la misma canción". El primero lo eligió YouTube y se da
 * por bueno; los demás tienen que ganarse el lugar, si no un pedido de
 * "Bohemian Rhapsody" demasiado largo podría terminar en otra canción con
 * "audio oficial" en el título.
 */
const MIN_ALT_COVERAGE = 0.6;

/** Palabras que no identifican la canción: conectores y marcadores de versión. */
const STOPWORDS = new Set([
  'de', 'la', 'el', 'los', 'las', 'y', 'en', 'un', 'una', 'del', 'por', 'con',
  'the', 'a', 'of', 'and', 'by', 'ft', 'feat', 'x',
  'official', 'oficial', 'audio', 'video', 'videoclip', 'lyrics', 'lyric', 'letra',
  'music', 'musica', 'cancion', 'song', 'hd', 'hq',
]);

/** Señales de que el resultado es la pista de audio (sin videoclip). */
const AUDIO_MARKERS: Array<[RegExp, number]> = [
  [/\b(official|oficial)\s+audio\b|\baudio\s+(official|oficial)\b/, 4],
  [/\blyrics?\b|\blyric\s+video\b|\bletra\b|\bcon\s+letra\b/, 3],
  [/\baudio\b/, 2],
];

/** Señales de videoclip: se usan sólo como desempate en contra. */
const VIDEO_MARKERS = /\b(official|oficial)\s+(music\s+)?video\b|\bvideo\s+oficial\b|\bmusic\s+video\b|\bvideoclip\b|\bofficial\s+mv\b|\b(m\/v|mv)\b/;

/**
 * Versiones que casi nunca son lo que se pidió. Se penalizan salvo que la
 * propia búsqueda las mencione ("despacito en vivo" sí quiere el en vivo).
 */
const UNWANTED_VARIANTS = [
  'live', 'en vivo', 'cover', 'karaoke', 'reaction', 'reaccion', 'remix',
  'sped up', 'slowed', 'nightcore', '8d', 'instrumental', 'tutorial', 'acustico', 'acoustic',
];

export function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

function contentTokens(text: string): string[] {
  return normalizeText(text)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Duración de YouTube ("3:45", "1:02:10") a minutos. `null` si no se puede
 * saber — un resultado sin duración se deja pasar, igual que hacía
 * `assertDurationWithin`.
 */
export function parseDurationMinutes(duration: unknown): number | null {
  if (typeof duration !== 'string' || !duration.trim()) return null;
  const parts = duration.trim().split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return null;
  if (parts.length === 2) return parts[0] + parts[1] / 60;
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
  return null;
}

/** Fracción de las palabras de la búsqueda que aparecen en título + canal. */
export function queryCoverage(query: string, video: any): number {
  const wanted = Array.from(new Set(contentTokens(query)));
  if (wanted.length === 0) return 1;
  const haystack = new Set(
    contentTokens(`${video?.title ?? ''} ${video?.author?.name ?? ''}`),
  );
  return wanted.filter((t) => haystack.has(t)).length / wanted.length;
}

/** Puntaje de "esto es el audio y no el videoclip". Mayor es mejor. */
export function audioScore(query: string, video: any): number {
  const title = normalizeText(video?.title ?? '');
  const author = (video?.author?.name ?? '') as string;
  const q = normalizeText(query);
  let score = 0;

  // Los canales "Artista - Topic" son los art tracks auto-generados por
  // YouTube Music: el audio de estudio tal cual, sin nada antes.
  if (/\s-\s*topic$/i.test(author.trim())) score += 5;

  for (const [re, points] of AUDIO_MARKERS) {
    if (re.test(title)) {
      score += points;
      break;
    }
  }
  if (VIDEO_MARKERS.test(title)) score -= 2;

  if (isUnwantedVariant(title, q)) score -= 4;
  return score;
}

/** Recibe título y búsqueda ya normalizados. */
function isUnwantedVariant(title: string, query: string): boolean {
  return UNWANTED_VARIANTS.some((variant) => {
    const re = new RegExp(`\\b${variant}\\b`);
    return re.test(title) && !re.test(query);
  });
}

/**
 * Elige entre los resultados de YouTube Music: gana el que más cubre la
 * búsqueda y, a igual cobertura, el que YouTube Music puso más arriba. No hay
 * puntaje de audio porque ahí todo es audio.
 *
 * `null` significa "seguí por YouTube", y sale en tres casos:
 *  - Ningún resultado se parece a lo pedido: el catálogo devuelve canciones
 *    aunque el pedido no esté en él, así que siempre hay algo que descartar.
 *  - La mejor coincidencia es demasiado larga. No se baja a la siguiente porque
 *    suele ser un cover: "stairway to heaven led zeppelin" dura 8 minutos y
 *    detrás viene un cover con "(Led Zeppelin)" en el título.
 *  - Se pidió una versión ("en vivo", "remix"). El catálogo las nombra de
 *    formas que la cobertura no empareja ("Live", "Ao Vivo"), y "despacito en
 *    vivo" terminaba en una versión desconocida en vez del en vivo de Fonsi.
 */
export function pickSong(songs: any[], query: string, maxMinutes: number): any | null {
  const q = normalizeText(query);
  if (isUnwantedVariant(q, '')) return null;

  let best: any | null = null;
  let bestCoverage = 0;
  for (const song of songs || []) {
    if (isUnwantedVariant(normalizeText(song?.title ?? ''), q)) continue;

    const coverage = queryCoverage(query, song);
    if (coverage >= MIN_ALT_COVERAGE && coverage > bestCoverage) {
      best = song;
      bestCoverage = coverage;
    }
  }

  const minutes = parseDurationMinutes(best?.duration);
  return minutes !== null && minutes > maxMinutes ? null : best;
}

export function pickVideo(videos: any[], query: string, options: PickOptions): PickResult {
  const results = (videos || []).filter((v) => v && !v.isLive);
  if (results.length === 0) return { video: null, tooLong: null };

  const topCoverage = queryCoverage(query, results[0]);
  // Si ni el primero cubre el 60% (búsqueda con apodos, typos), no se le
  // exige más que eso a los demás.
  const minCoverage = Math.min(MIN_ALT_COVERAGE, topCoverage);
  const relevant = results.filter(
    (v, i) => i === 0 || queryCoverage(query, v) >= minCoverage,
  );

  const fits = relevant.filter((v) => {
    const minutes = parseDurationMinutes(v.duration);
    return minutes === null || minutes <= options.maxMinutes;
  });
  if (fits.length === 0) return { video: null, tooLong: relevant[0] };

  if (!options.preferAudio) return { video: fits[0], tooLong: null };

  // El orden de YouTube desempata: entre dos audios oficiales gana el que
  // YouTube puso más arriba.
  let best = fits[0];
  let bestScore = audioScore(query, best);
  for (const candidate of fits.slice(1)) {
    const score = audioScore(query, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return { video: best, tooLong: null };
}
