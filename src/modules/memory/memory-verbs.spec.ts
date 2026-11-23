import { extractMemoryVerbs, validateMemoryDraft, MEMORY_VERB_PATTERN_SOURCE } from './memory-verbs';

// 2026-11-22 10:00 en El Salvador.
const NOW = new Date('2026-11-22T16:00:00Z');

describe('extractMemoryVerbs', () => {
  it('saca RECUERDO del texto y devuelve sus campos', () => {
    const out = extractMemoryVerbs(
      'Uh, suerte! RECUERDO(evento | Victoria rinde el examen de cálculo | examen, calculo, facultad | 2026-11-27 | 15:00 | no)',
    );
    expect(out.content).toBe('Uh, suerte!');
    expect(out.saves).toEqual([
      ['evento', 'Victoria rinde el examen de cálculo', 'examen, calculo, facultad', '2026-11-27', '15:00', 'no'],
    ]);
    expect(out.changes).toEqual([]);
    expect(out.closes).toEqual([]);
  });

  it('saca RECUERDO_CAMBIO y RECUERDO_CERRADO, y varios verbos en una respuesta', () => {
    const out = extractMemoryVerbs(
      'Ah, lo pasaron. RECUERDO_CAMBIO(r1 | 2026-11-30) Y lo otro listo RECUERDO_CERRADO(r2) RECUERDO(dato | Tiene un gato | gato)',
    );
    expect(out.content).toBe('Ah, lo pasaron. Y lo otro listo');
    expect(out.changes).toEqual([{ ref: 'r1', eventDate: '2026-11-30' }]);
    expect(out.closes).toEqual(['r2']);
    expect(out.saves).toEqual([['dato', 'Tiene un gato', 'gato']]);
  });

  it('RECUERDO_CAMBIO con hora', () => {
    expect(extractMemoryVerbs('RECUERDO_CAMBIO( r3 | 2026-12-01 | 09:30 )').changes).toEqual([
      { ref: 'r3', eventDate: '2026-12-01', eventTime: '09:30' },
    ]);
  });

  it('conserva comas y paréntesis balanceados dentro de un campo', () => {
    const out = extractMemoryVerbs('RECUERDO(evento | rinde (otra vez) el parcial, ojalá | parcial | 2026-11-27)');
    expect(out.saves[0][1]).toBe('rinde (otra vez) el parcial, ojalá');
    expect(out.content).toBe('');
  });

  it('sin verbos devuelve el texto tal cual', () => {
    const text = '  hola  che ';
    expect(extractMemoryVerbs(text)).toEqual({ content: text, saves: [], changes: [], closes: [] });
  });

  it('un verbo sin cerrar se corta hasta el final', () => {
    expect(extractMemoryVerbs('dale RECUERDO(dato | algo').content).toBe('dale');
  });

  it('la palabra recuerdo en minúscula es charla, no un verbo', () => {
    const text = 'qué lindo recuerdo (de cuando fuimos a la playa)';
    expect(extractMemoryVerbs(text)).toEqual({ content: text, saves: [], changes: [], closes: [] });
  });

  it('MEMORY_VERB_PATTERN_SOURCE reconoce los tres verbos, sólo en mayúsculas', () => {
    const re = new RegExp(MEMORY_VERB_PATTERN_SOURCE);
    expect(re.test('RECUERDO(')).toBe(true);
    expect(re.test('RECUERDO_CAMBIO (')).toBe(true);
    expect(re.test('recuerdo_cerrado(')).toBe(false);
    expect(re.test('un recuerdo lindo')).toBe(false);
  });
});

describe('validateMemoryDraft', () => {
  it('evento completo', () => {
    expect(
      validateMemoryDraft(['evento', 'Rinde el examen de cálculo', 'Examen, Cálculo, facultad', '2026-11-27', '15:00', 'no'], NOW),
    ).toEqual({
      kind: 'event',
      text: 'Rinde el examen de cálculo',
      keywords: ['examen', 'calculo', 'facultad'],
      eventDate: '2026-11-27',
      eventTime: '15:00',
      sensitive: false,
    });
  });

  it.each([
    ['evento', 'event'],
    ['event', 'event'],
    ['dato', 'fact'],
    ['fact', 'fact'],
    ['compartido', 'shared'],
    ['Shared', 'shared'],
  ])('tipo %s → %s', (raw, kind) => {
    const fields = kind === 'event' ? [raw, 'algo', 'a', '2026-11-27'] : [raw, 'algo', 'a'];
    expect(validateMemoryDraft(fields, NOW)?.kind).toBe(kind);
  });

  it('tipo desconocido o texto vacío → null', () => {
    expect(validateMemoryDraft(['chisme', 'algo', 'a'], NOW)).toBeNull();
    expect(validateMemoryDraft(['dato', '   ', 'a'], NOW)).toBeNull();
    expect(validateMemoryDraft(['dato'], NOW)).toBeNull();
  });

  it('recorta el texto a 200 y las claves a 6, normalizadas', () => {
    const out = validateMemoryDraft(['dato', 'x'.repeat(250), 'Á, b, c, d, e, f, g, h'], NOW);
    expect(out?.text).toHaveLength(200);
    expect(out?.keywords).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('acepta menos de 3 claves y descarta las vacías', () => {
    expect(validateMemoryDraft(['dato', 'algo', 'gato, , '], NOW)?.keywords).toEqual(['gato']);
  });

  it.each(['si', 'sí', 'yes', 'true', 'SÍ'])('delicado = %s', (flag) => {
    expect(validateMemoryDraft(['dato', 'algo', 'a', '', '', flag], NOW)?.sensitive).toBe(true);
  });

  it('un dato no guarda fecha aunque la traiga', () => {
    const out = validateMemoryDraft(['dato', 'algo', 'a', '2026-11-27', '10:00'], NOW);
    expect(out?.eventDate).toBeUndefined();
    expect(out?.eventTime).toBeUndefined();
  });

  // Review Focus: fecha relativa o mal formada.
  it.each(['viernes', '27/11', '2026-13-01', '2026-02-30', '2026-11-20', '2027-11-23', ''])(
    'evento con fecha "%s" queda como dato, sin fecha',
    (date) => {
      const out = validateMemoryDraft(['evento', 'Rinde el examen', 'examen', date, '10:00'], NOW);
      expect(out?.kind).toBe('fact');
      expect(out?.eventDate).toBeUndefined();
      expect(out?.eventTime).toBeUndefined();
    },
  );

  it('ayer y +1 año todavía valen', () => {
    expect(validateMemoryDraft(['evento', 'a', 'a', '2026-11-21'], NOW)?.eventDate).toBe('2026-11-21');
    expect(validateMemoryDraft(['evento', 'a', 'a', '2027-11-22'], NOW)?.eventDate).toBe('2027-11-22');
  });

  it('hora inválida se descarta sola', () => {
    const out = validateMemoryDraft(['evento', 'a', 'a', '2026-11-27', '25:00'], NOW);
    expect(out?.eventDate).toBe('2026-11-27');
    expect(out?.eventTime).toBeUndefined();
  });
});
