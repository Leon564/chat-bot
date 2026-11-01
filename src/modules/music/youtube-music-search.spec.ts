import { parseSongResults } from './youtube-music-search';

const row = (videoId: string | undefined, title: string, details: string, extra: any = {}) => ({
  musicResponsiveListItemRenderer: {
    playlistItemData: videoId ? { videoId } : undefined,
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
      {
        musicResponsiveListItemFlexColumnRenderer: {
          text: { runs: details.split(/( • )/).map((text) => ({ text })) },
        },
      },
    ],
    ...extra,
  },
});

const response = (...rows: any[]) => ({
  contents: {
    tabbedSearchResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: rows } }] },
            },
          },
        },
      ],
    },
  },
});

describe('parseSongResults', () => {
  it('deja cada canción con la forma de un item de ytsr', () => {
    const [song] = parseSongResults(response(row('HfpR4tAmI7E', 'Love Me Not', "Ravyn Lenae • Bird's Eye • 3:34")));
    expect(song).toEqual({
      type: 'video',
      title: 'Love Me Not',
      url: 'https://www.youtube.com/watch?v=HfpR4tAmI7E',
      duration: '3:34',
      author: { name: 'Ravyn Lenae' },
      bestThumbnail: { url: 'https://i.ytimg.com/vi/HfpR4tAmI7E/hqdefault.jpg' },
    });
  });

  it('sin duración legible deja `duration` en null', () => {
    const [song] = parseSongResults(response(row('id', 'Tema', 'Artista • Álbum')));
    expect(song.duration).toBeNull();
    expect(song.author).toEqual({ name: 'Artista' });
  });

  it('saltea filas sin videoId o no reproducibles', () => {
    const songs = parseSongResults(
      response(
        row(undefined, 'Sin id', 'A • 3:00'),
        row('gris', 'Gris', 'A • 3:00', {
          musicItemRendererDisplayPolicy: 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT',
        }),
        row('ok', 'Bien', 'A • 3:00'),
      ),
    );
    expect(songs.map((s) => s.title)).toEqual(['Bien']);
  });

  it('una respuesta con otra estructura devuelve vacío', () => {
    expect(parseSongResults({})).toEqual([]);
    expect(parseSongResults(null)).toEqual([]);
    expect(parseSongResults({ contents: { tabbedSearchResultsRenderer: { tabs: [{}] } } })).toEqual([]);
  });
});
