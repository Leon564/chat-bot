/**
 * Búsqueda en el catálogo de YouTube Music. A diferencia de la búsqueda de
 * YouTube, devuelve canciones publicadas y no videos subidos: el primer
 * resultado de "love me not ravyn" es la pista original del álbum, no un
 * videoclip, una versión con otro artista ni un lyric video de terceros.
 *
 * Es el endpoint interno que usa el sitio (InnerTube): no pide API key, pero
 * tampoco es un contrato público. Por eso el llamador trata cualquier fallo
 * como "sin resultados" y sigue con la búsqueda normal de YouTube.
 *
 * Todo acá es puro (sin red) para poder testearlo directo.
 */

export const YOUTUBE_MUSIC_SEARCH_URL =
  'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';

/** Filtro "Canciones" de YouTube Music: deja afuera videos, álbumes y artistas. */
const SONGS_FILTER = 'EgWKAQIIAWoKEAoQCRADEAQQBQ==';

const CLIENT_VERSION = '1.20250101.01.00';

const DURATION_RE = /^\d{1,2}(:\d{2}){1,2}$/;

export function buildSongSearchBody(query: string): Record<string, unknown> {
  return {
    query,
    params: SONGS_FILTER,
    context: {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: CLIENT_VERSION,
        hl: 'en',
        gl: 'US',
      },
    },
  };
}

function runsText(text: any): string {
  return (text?.runs ?? []).map((run: any) => run?.text ?? '').join('');
}

/**
 * Convierte la respuesta en la misma forma que los items de `ytsr`, porque de
 * ahí en más el pipeline (descarga, BBCode, grafo) no distingue el origen.
 * Una respuesta con otra estructura devuelve `[]`, nunca lanza.
 */
export function parseSongResults(response: any): any[] {
  const tabs = response?.contents?.tabbedSearchResultsRenderer?.tabs ?? [];
  const sections = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  const songs: any[] = [];

  for (const section of sections) {
    for (const item of section?.musicShelfRenderer?.contents ?? []) {
      const renderer = item?.musicResponsiveListItemRenderer;
      const videoId = renderer?.playlistItemData?.videoId;
      // GREY_OUT es como el sitio marca lo que no se puede reproducir.
      if (!videoId || renderer?.musicItemRendererDisplayPolicy?.includes('GREY_OUT')) continue;

      const [titleColumn, detailsColumn] = renderer.flexColumns ?? [];
      const title = runsText(titleColumn?.musicResponsiveListItemFlexColumnRenderer?.text);
      if (!title) continue;

      // "Artista • Álbum • 3:34"; el álbum puede faltar.
      const details = runsText(detailsColumn?.musicResponsiveListItemFlexColumnRenderer?.text)
        .split(' • ')
        .map((part) => part.trim());
      const lastDetail = details[details.length - 1];

      songs.push({
        type: 'video',
        title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        duration: DURATION_RE.test(lastDetail) ? lastDetail : null,
        author: details[0] ? { name: details[0] } : undefined,
        bestThumbnail: { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` },
      });
    }
  }
  return songs;
}
