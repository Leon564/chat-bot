import { MusicIntentService, MUSIC_INTENT_THRESHOLD } from './music-intent.service';

/** Grafo falso: conoce a Yorushika (artista) y "ita song" (canción). */
const graph = {
  resolveByAlias: jest.fn(async (alias: string) => {
    const known: Record<string, { type: string; label: string }> = {
      yorushika: { type: 'artist', label: 'Yorushika' },
      'ita song': { type: 'track', label: 'Ita Song' },
    };
    return known[alias.trim().toLowerCase()] ?? null;
  }),
};

const service = new MusicIntentService(graph as never);

describe('MusicIntentService', () => {
  beforeEach(() => graph.resolveByAlias.mockClear());

  it.each([
    // verbo claro al principio: alcanza aunque el grafo no lo conozca
    ['reproduce lemon de kenshi yonezu', 'lemon de kenshi yonezu'],
    ['reproducí the rumbling', 'the rumbling'],
    ['play bad apple', 'bad apple'],
    ['ponme la canción de yorushika', 'yorushika'],
    ['reproduce "unravel"', 'unravel'],
    ['reproduce el tema de evangelion', 'evangelion'],
    // verbos ambiguos: pasan sólo con el grafo
    ['pon yorushika', 'yorushika'],
    ['pon ita song de yorushika', 'ita song de yorushika'],
    ['toca ita song', 'ita song'],
  ])('"%s" es un pedido (busca "%s")', async (content, query) => {
    const intent = await service.classify(content);
    expect(intent).toEqual(expect.objectContaining({ isRequest: true, query }));
  });

  it.each([
    // no empiezan con el verbo: ni califican
    'quién reproduce el video?',
    'el tema de hoy es el torneo',
    'me encanta la música de ese anime',
    'quiero escuchar tu opinión',
    // empiezan con el verbo pero son charla
    'pon atención',
    'pon un ejemplo de eso',
    'toca esperar',
    'reproduce el video de ayer',
    'reproduce eso otra vez?',
    'pon en mute el stream',
    'pon desconocida que nadie pidió nunca', // "pon" + nada conocido en el grafo
    'reproduce x', // demasiado corto
  ])('"%s" no es un pedido', async (content) => {
    const intent = await service.classify(content);
    expect(intent?.isRequest ?? false).toBe(false);
  });

  it('sólo consulta el grafo cuando puede cambiar el resultado', async () => {
    await service.classify('reproduce lemon'); // ya pasa sin grafo
    await service.classify('reproduce eso?'); // no llega ni con grafo
    expect(graph.resolveByAlias).not.toHaveBeenCalled();

    await service.classify('pon yorushika');
    expect(graph.resolveByAlias).toHaveBeenCalledWith('yorushika', ['track', 'artist']);
  });

  it('busca la canción y el artista por separado', () => {
    expect(MusicIntentService.graphNeedles('ita song de yorushika')).toEqual([
      'ita song de yorushika',
      'ita song',
      'yorushika',
    ]);
  });

  it('si el grafo falla, decide sólo con el texto', async () => {
    const broken = new MusicIntentService({ resolveByAlias: jest.fn().mockRejectedValue(new Error('caído')) } as never);
    expect((await broken.classify('pon yorushika'))?.isRequest).toBe(false);
    expect((await broken.classify('reproduce yorushika'))?.isRequest).toBe(true);
  });

  it('sin grafo (tests armados a mano) funciona sólo con el texto', async () => {
    const bare = new MusicIntentService();
    expect((await bare.classify('reproduce yorushika'))?.score).toBe(MUSIC_INTENT_THRESHOLD);
  });
});
