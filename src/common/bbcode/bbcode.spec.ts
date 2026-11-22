import {
  bbcodeToPlain,
  findEmptyBbcode,
  normalizeDisabledBbcodes,
  rebalanceBbcodeParts,
  sanitizeBotBbcode,
  stripHtmlTags,
} from './bbcode';

describe('bbcode (bot)', () => {
  describe('sanitizeBotBbcode', () => {
    it('deja intacto un mensaje bien formado', () => {
      const text = '[b][i]hola[/i][/b] [color=#f06]rosa[/color] [url=https://anilist.co/x]ficha[/url] ||final||';
      expect(sanitizeBotBbcode(text)).toBe(text);
    });

    it('quita el </color> suelto estilo HTML y convierte un par <color> a BBCode', () => {
      expect(sanitizeBotBbcode('Tranqui, cumplo 😌 quién sabe</color>')).toBe('Tranqui, cumplo 😌 quién sabe');
      expect(sanitizeBotBbcode('<@kiki> hola </color> [color=#f06]rosa[/color]')).toBe('<@kiki> hola  [color=#f06]rosa[/color]');
      expect(sanitizeBotBbcode('<color=#ff6699>hola</color>')).toBe('[color=#ff6699]hola[/color]');
      expect(sanitizeBotBbcode('<color=rojo>hola</color>')).toBe('hola');
      expect(sanitizeBotBbcode('<color>hola')).toBe('hola');
    });

    it('quita tags vacíos, en cascada', () => {
      expect(sanitizeBotBbcode('hola [b][/b] mundo')).toBe('hola  mundo');
      expect(sanitizeBotBbcode('x [b][i]   [/i][/b] y')).toBe('x   y');
      expect(findEmptyBbcode(sanitizeBotBbcode('[shake] [/shake]ok [url][/url]'))).toBeNull();
    });

    it('quita tags huérfanos y cruzados', () => {
      expect(sanitizeBotBbcode('[b]hola')).toBe('hola');
      expect(sanitizeBotBbcode('mundo[/b]')).toBe('mundo');
      expect(sanitizeBotBbcode('[b][i]x[/b][/i]')).toBe('[b]x[/b]');
    });

    it('no deja el mismo tag anidado en sí mismo', () => {
      expect(sanitizeBotBbcode('[b]a [b]b[/b] c[/b]')).toBe('[b]a b[/b] c');
    });

    it('desarma los tags apagados dejando el contenido', () => {
      const off = new Set(['shake', 'spoiler']);
      expect(sanitizeBotBbcode('[shake]¡ojo![/shake] [b]sí[/b] ||fin||', off)).toBe('¡ojo! [b]sí[/b] fin');
    });

    it('desarma color y url inválidos', () => {
      expect(sanitizeBotBbcode('[color=red]x[/color]')).toBe('x');
      expect(sanitizeBotBbcode('[url=javascript:alert(1)]x[/url]')).toBe('x');
      expect(sanitizeBotBbcode('[url]no es link[/url]')).toBe('no es link');
      expect(sanitizeBotBbcode('[url]https://a.com/b[/url]')).toBe('[url]https://a.com/b[/url]');
    });

    it('no interpreta lo de adentro de [code], salvo tags vacíos', () => {
      expect(sanitizeBotBbcode('[code][b]literal[/code]')).toBe('[code][b]literal[/code]');
      expect(sanitizeBotBbcode('[code]a [i][/i] b[/code]')).toBe('[code]a  b[/code]');
    });

    it('no toca adjuntos ni texto con corchetes que no son tags', () => {
      const text = '[audio title="x"]https://f.com/a.mp3[/audio] [Official Video] [bold]';
      expect(sanitizeBotBbcode(text)).toBe(text);
    });
  });

  describe('rebalanceBbcodeParts', () => {
    it('cierra y reabre lo que quedó abierto en el corte', () => {
      expect(rebalanceBbcodeParts(['[b]hola [color=#f00]a', 'b[/color] mundo[/b] fin'])).toEqual([
        '[b]hola [color=#f00]a[/color][/b]',
        '[b][color=#f00]b[/color] mundo[/b] fin',
      ]);
    });

    it('un [code] partido se reabre como code', () => {
      expect(rebalanceBbcodeParts(['[code]uno [b]', 'dos[/code]'])).toEqual([
        '[code]uno [b][/code]',
        '[code]dos[/code]',
      ]);
    });

    it('con una sola parte no cambia nada', () => {
      expect(rebalanceBbcodeParts(['[b]x'])).toEqual(['[b]x']);
    });

    it('un tag abierto justo al final queda vacío y la sanitización lo quita', () => {
      const parts = rebalanceBbcodeParts(['hola [b]', 'mundo[/b]']);
      expect(parts.map((p) => sanitizeBotBbcode(p))).toEqual(['hola ', '[b]mundo[/b]']);
    });
  });

  describe('bbcodeToPlain', () => {
    it('quita formato y color y deja el contenido', () => {
      expect(bbcodeToPlain('^#3ca6ec [b]hola[/b] [shake]ya[/shake] [color=#f00]rojo[/color]', 'mark')).toBe(
        'hola ya rojo',
      );
    });

    it('links: texto + url', () => {
      expect(bbcodeToPlain('[url=https://a.com]ficha[/url] y [url]https://b.com[/url]', 'mark')).toBe(
        'ficha (https://a.com) y https://b.com',
      );
    });

    it('spoilers: marcados para el modelo, tapados para la memoria', () => {
      const text = 'el final: [spoiler]muere[/spoiler] y ||vuelve||';
      expect(bbcodeToPlain(text, 'mark')).toBe('el final: (spoiler: muere) y (spoiler: vuelve)');
      expect(bbcodeToPlain(text, 'hide')).toBe('el final: [spoiler] y [spoiler]');
    });
  });

  it('normalizeDisabledBbcodes filtra nombres desconocidos', () => {
    expect(normalizeDisabledBbcodes(['SHAKE', '[scroll]', 'img', 3])).toEqual(['shake', 'scroll']);
    expect(normalizeDisabledBbcodes(undefined)).toEqual([]);
  });

  describe('stripHtmlTags', () => {
    it('saca las etiquetas de medios enteras (el GIF que el modelo inventó en prod)', () => {
      expect(stripHtmlTags('<img src="https://media.tenor.com/..."/> hola')).toBe(' hola');
      expect(stripHtmlTags('a <video src="x.mp4"></video> b')).toBe('a  b');
      expect(stripHtmlTags('<IFRAME src="x">')).toBe('');
    });

    it('de las de formato saca la etiqueta y deja el contenido', () => {
      expect(stripHtmlTags('<b>hola</b> <i>che</i><br/>fin')).toBe('hola chefin');
      expect(stripHtmlTags('<a href="https://x.com">link</a>')).toBe('link');
    });

    it('no toca menciones, corazones ni flechas', () => {
      const text = '<@kiki> te quiero <3 y <- eso, 2 < 3 > 1';
      expect(stripHtmlTags(text)).toBe(text);
    });

    it('sanitizeBotBbcode la aplica', () => {
      expect(sanitizeBotBbcode('<img src="x.gif"/>[b]sí[/b]')).toBe('[b]sí[/b]');
    });
  });
});
