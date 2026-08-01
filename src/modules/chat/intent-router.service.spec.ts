import { Test } from '@nestjs/testing';
import { IntentRouterService } from './intent-router.service';

describe('IntentRouterService', () => {
  let router: IntentRouterService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [IntentRouterService],
    }).compile();
    router = moduleRef.get<IntentRouterService>(IntentRouterService);
  });

  const rutear = (msg: string, useMemory = true) => router.route(msg, { useMemory });

  it('siempre incluye PERSONA y TEMPORAL', async () => {
    for (const msg of ['hola', 'bot pon musica', 'cualquier cosa', '']) {
      const bloques = await rutear(msg);
      expect(bloques).toContain('PERSONA');
      expect(bloques).toContain('TEMPORAL');
    }
  });

  describe('ANILIST — el único sin red de seguridad, router permisivo', () => {
    const debenIncluir = [
      'bot qué tal está Berserk?',
      'recomiendame un manhwa',
      'bot info de solo leveling',
      'el anime de demon slayer está bueno?',
      'alguien leyó ese manga de la torre?',
      'bot cuántos capítulos tiene one piece',
      'qué temporada va de jujutsu',
      'me recomiendas algo para leer',
      'bot buscá berserk y vagabond',
      'esta bueno el manhua ese',
      'que estas viendo ahora?',
    ];

    it.each(debenIncluir)('incluye ANILIST para: %s', async (msg) => {
      expect(await rutear(msg)).toContain('ANILIST');
    });

    const noNecesitan = ['hola', 'buenas noches bot', 'jajaja', 'gracias bot'];

    it.each(noNecesitan)('omite ANILIST para: %s', async (msg) => {
      expect(await rutear(msg)).not.toContain('ANILIST');
    });
  });

  describe('MUSIC', () => {
    const debenIncluir = [
      'bot reproduce yorushika',
      'pon música de radiohead',
      '!music gods league of legends',
      'quiero escuchar algo tranquilo',
      'ponme esa canción',
      'bot tocá algo',
    ];

    it.each(debenIncluir)('incluye MUSIC para: %s', async (msg) => {
      expect(await rutear(msg)).toContain('MUSIC');
    });

    it('omite MUSIC en una charla cualquiera', async () => {
      expect(await rutear('hola cómo va todo')).not.toContain('MUSIC');
    });
  });

  describe('ONLINE', () => {
    const debenIncluir = [
      'quién está en línea?',
      'cuántos hay conectados',
      'bot mostrame los usuarios',
      'quién anda por aquí',
      'who is online',
    ];

    it.each(debenIncluir)('incluye ONLINE para: %s', async (msg) => {
      expect(await rutear(msg)).toContain('ONLINE');
    });

    it('omite ONLINE cuando preguntan por UNA persona', async () => {
      expect(await rutear('está el admin online?')).not.toContain('ONLINE');
    });
  });

  describe('RESUMEN', () => {
    it.each(['bot dame un resumen', 'qué pasó en el chat', 'hacé un recap'])(
      'incluye RESUMEN para: %s',
      async (msg) => {
        expect(await rutear(msg)).toContain('RESUMEN');
      },
    );
  });

  describe('IDENTIDAD', () => {
    it.each([
      'bot quién te creó?',
      'cuáles son las reglas del chat',
      'pasame el discord',
      'quién es tu padre',
    ])('incluye IDENTIDAD para: %s', async (msg) => {
      expect(await rutear(msg)).toContain('IDENTIDAD');
    });

    it('omite IDENTIDAD en una charla cualquiera', async () => {
      expect(await rutear('hola qué tal')).not.toContain('IDENTIDAD');
    });
  });

  describe('SAVE_MEMORY', () => {
    it('se incluye cuando el mensaje trae un hecho y useMemory está activo', async () => {
      expect(await rutear('bot me encanta attack on titan')).toContain('SAVE_MEMORY');
      expect(await rutear('tengo 25 años')).toContain('SAVE_MEMORY');
    });

    it('nunca se incluye con useMemory desactivado', async () => {
      expect(await rutear('me encanta attack on titan', false)).not.toContain('SAVE_MEMORY');
    });

    it('se omite en un saludo simple', async () => {
      expect(await rutear('hola')).not.toContain('SAVE_MEMORY');
    });
  });

  describe('saludo simple — el caso que más ahorra', () => {
    it.each(['hola', 'hey bot', 'buenas', 'qué tal'])(
      'para "%s" sólo deja PERSONA y TEMPORAL',
      async (msg) => {
        expect((await rutear(msg)).sort()).toEqual(['PERSONA', 'TEMPORAL']);
      },
    );
  });

  it('nunca devuelve un bloque repetido', async () => {
    const bloques = await rutear('bot pon música de berserk y decime quién está online');
    expect(new Set(bloques).size).toBe(bloques.length);
  });
});
