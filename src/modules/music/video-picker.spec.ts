import { audioScore, parseDurationMinutes, pickVideo, queryCoverage } from './video-picker';

const v = (title: string, duration: string | null, author = 'Canal', extra: any = {}) => ({
  title,
  duration,
  author: { name: author },
  url: `https://youtu.be/${encodeURIComponent(title)}`,
  ...extra,
});

const audio = { maxMinutes: 8, preferAudio: true };

describe('parseDurationMinutes', () => {
  it('entiende MM:SS y HH:MM:SS', () => {
    expect(parseDurationMinutes('3:30')).toBe(3.5);
    expect(parseDurationMinutes('1:02:00')).toBe(62);
  });

  it('devuelve null si no hay duración legible', () => {
    expect(parseDurationMinutes(null)).toBeNull();
    expect(parseDurationMinutes('')).toBeNull();
    expect(parseDurationMinutes('abc')).toBeNull();
  });
});

describe('pickVideo — prioridad de audio', () => {
  it('prefiere el audio oficial sobre el videoclip oficial', () => {
    const videos = [
      v('Queen - Bohemian Rhapsody (Official Video)', '5:59', 'Queen Official'),
      v('Queen - Bohemian Rhapsody (Official Audio)', '5:55', 'Queen Official'),
    ];
    expect(pickVideo(videos, 'queen bohemian rhapsody', audio).video).toBe(videos[1]);
  });

  it('prefiere el lyric video sobre el videoclip', () => {
    const videos = [
      v('Bad Bunny - Tití Me Preguntó (Video Oficial)', '4:20'),
      v('Bad Bunny - Tití Me Preguntó (Letra/Lyrics)', '4:03'),
    ];
    expect(pickVideo(videos, 'titi me pregunto bad bunny', audio).video).toBe(videos[1]);
  });

  it('el art track de un canal "- Topic" gana sobre todo lo demás', () => {
    const videos = [
      v('Daft Punk - One More Time (Official Video)', '5:20', 'Daft Punk'),
      v('Daft Punk - One More Time (Lyrics)', '5:20', 'LyricsChannel'),
      v('One More Time', '5:20', 'Daft Punk - Topic'),
    ];
    expect(pickVideo(videos, 'daft punk one more time', audio).video).toBe(videos[2]);
  });

  it('no salta a un cover o un en vivo sólo porque diga "audio"', () => {
    const videos = [
      v('Soda Stereo - De Música Ligera', '3:32'),
      v('De Música Ligera (Cover Audio)', '3:40'),
      v('Soda Stereo - De Música Ligera (En Vivo) Audio', '4:10'),
    ];
    expect(pickVideo(videos, 'soda stereo de musica ligera', audio).video).toBe(videos[0]);
  });

  it('respeta la variante si la búsqueda la pide', () => {
    const videos = [
      v('Soda Stereo - De Música Ligera (Official Video)', '3:32'),
      v('Soda Stereo - De Música Ligera (En Vivo)', '4:10'),
    ];
    expect(pickVideo(videos, 'soda stereo de musica ligera en vivo', audio).video).toBe(videos[1]);
  });

  it('no cambia a otra canción aunque tenga "official audio"', () => {
    const videos = [
      v('Queen - Bohemian Rhapsody (Official Video)', '5:59'),
      v('Queen - Another One Bites The Dust (Official Audio)', '3:35'),
    ];
    expect(pickVideo(videos, 'queen bohemian rhapsody', audio).video).toBe(videos[0]);
  });

  it('para video NO aplica la prioridad de audio', () => {
    const videos = [
      v('Queen - Bohemian Rhapsody (Official Video)', '4:59'),
      v('Queen - Bohemian Rhapsody (Official Audio)', '4:55'),
    ];
    expect(
      pickVideo(videos, 'queen bohemian rhapsody', { maxMinutes: 5, preferAudio: false }).video,
    ).toBe(videos[0]);
  });
});

describe('pickVideo — límite de duración', () => {
  it('si el primero es demasiado largo toma el siguiente que siga siendo la canción', () => {
    const videos = [
      v('Pink Floyd - Echoes (Live at Pompeii)', '25:12'),
      v('Gorillaz - Feel Good Inc', '3:41'),
      v('Pink Floyd - Echoes (Radio Edit)', '7:20'),
    ];
    const result = pickVideo(videos, 'pink floyd echoes', audio);
    expect(result.video).toBe(videos[2]);
  });

  it('si ningún resultado relevante entra, devuelve el demasiado largo para el error', () => {
    const videos = [
      v('Pink Floyd - Echoes', '23:31'),
      v('Gorillaz - Feel Good Inc', '3:41'),
    ];
    const result = pickVideo(videos, 'pink floyd echoes', audio);
    expect(result.video).toBeNull();
    expect(result.tooLong).toBe(videos[0]);
  });

  it('el límite de video es independiente', () => {
    const videos = [v('Tool - Schism (Official Video)', '6:47'), v('Tool - Schism (short)', '4:50')];
    expect(
      pickVideo(videos, 'tool schism', { maxMinutes: 5, preferAudio: false }).video,
    ).toBe(videos[1]);
  });

  it('un resultado sin duración se deja pasar, y los en vivo (streams) se ignoran', () => {
    const videos = [v('Lofi radio 24/7', null, 'Lofi', { isLive: true }), v('lofi beat', null)];
    expect(pickVideo(videos, 'lofi', audio).video).toBe(videos[1]);
  });

  it('sin resultados devuelve null sin tooLong', () => {
    expect(pickVideo([], 'x', audio)).toEqual({ video: null, tooLong: null });
  });
});

describe('queryCoverage / audioScore', () => {
  it('ignora acentos, mayúsculas y marcadores de versión', () => {
    expect(queryCoverage('Tití me preguntó audio oficial', v('TITI ME PREGUNTO', '1:00'))).toBe(1);
  });

  it('cuenta el nombre del canal como parte del resultado', () => {
    expect(queryCoverage('daft punk one more time', v('One More Time', '1:00', 'Daft Punk - Topic'))).toBe(1);
  });

  it('el videoclip puntúa por debajo de un resultado neutro', () => {
    expect(audioScore('x', v('Song (Official Music Video)', '1:00'))).toBeLessThan(
      audioScore('x', v('Song', '1:00')),
    );
  });
});
