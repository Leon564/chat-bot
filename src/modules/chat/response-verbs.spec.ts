import { ResponseVerbs } from './response-verbs';

describe('ResponseVerbs.stripModelLeaks', () => {
  it('el caso de prod: <img> + "wait no BBCode only." al principio', () => {
    const raw =
      '<img src="https://media.tenor.com/..."/> wait no BBCode only.\n\nPoné los ojos en su lugar 😏';
    expect(ResponseVerbs.stripModelLeaks(raw)).toBe('Poné los ojos en su lugar 😏');
  });

  it.each([
    ['Oops, no HTML here. Dale, ahí va', 'Dale, ahí va'],
    ['Espera, sin markdown. Jaja sí', 'Jaja sí'],
    ['esperá, nada de BBCode... Bueno, ok', 'Bueno, ok'],
    ['Perdón, el chat no usa HTML! Igual te quiero', 'Igual te quiero'],
  ])('autocorrección que nombra el formato: %s', (raw, expected) => {
    expect(ResponseVerbs.stripModelLeaks(raw)).toBe(expected);
  });

  it.each([
    'Ah, no sé, preguntale a león 😅',
    'Espera que lo busco',
    'Wait, ¿en serio? jaja',
    'El BBCode del chat es raro, wait no BBCode only.',
    'Oh, me encanta ese anime',
  ])('no toca charla normal: %s', (text) => {
    expect(ResponseVerbs.stripModelLeaks(text)).toBe(text);
  });

  it('sin nada que limpiar devuelve el texto tal cual (sin recortar)', () => {
    const text = '  hola <@kei> <3  ';
    expect(ResponseVerbs.stripModelLeaks(text)).toBe(text);
  });

  it('si sólo había la fuga queda vacío', () => {
    expect(ResponseVerbs.stripModelLeaks('<img src="x.gif"/>')).toBe('');
  });
});

describe('ResponseVerbs.stripLeftoverVerbs — verbos de memoria', () => {
  it('borra un RECUERDO* que haya sobrevivido', () => {
    expect(ResponseVerbs.stripLeftoverVerbs('hola RECUERDO_CERRADO(r1)')).toBe('hola');
    expect(ResponseVerbs.stripLeftoverVerbs('dale RECUERDO (dato | algo | a) che')).toBe('dale che');
  });

  it('no toca la palabra recuerdo en la charla', () => {
    const text = 'qué lindo recuerdo (de verdad)';
    expect(ResponseVerbs.stripLeftoverVerbs(text)).toBe(text);
  });
});
