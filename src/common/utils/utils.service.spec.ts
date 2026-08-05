import { UtilsService } from './utils.service';

/**
 * `UtilsService` no tiene dependencias propias (ni ConfigService ni Mongoose),
 * así que no hace falta `Test.createTestingModule` ni módulo de Nest: alcanza
 * con instanciarlo directamente.
 *
 * Este archivo no existía hasta la ronda de corrección 1 de la Task 4 (fase
 * 4b): `sanitizeMemoryContent` es la defensa contra inyección de todo el
 * sistema de memoria/hechos (strippea SAVE_MEMORY/SAVE_FACT anidados, BBCode
 * de media, tokens de intención, etc.) y nunca había tenido un test propio —
 * el cambio de regex de esa misma ronda (de `SAVE_MEMORY` a
 * `SAVE_(MEMORY|FACT)`) podía revertirse sin que ningún test del repo lo
 * notara.
 */
describe('UtilsService — sanitizeMemoryContent', () => {
  let service: UtilsService;

  beforeEach(() => {
    service = new UtilsService();
  });

  it('un SAVE_FACT(...) anidado no sobrevive a la sanitización', () => {
    const sucio = 'Nico le gusta esto SAVE_FACT(likes, otra cosa) tambien';

    const limpio = service.sanitizeMemoryContent(sucio);

    // Aserción fuerte (no sólo "no contiene la palabra"): si el regex
    // volviera a ser sólo `SAVE_MEMORY`, este `toBe` fallaría porque
    // "SAVE_FACT(likes, otra cosa)" seguiría en el resultado.
    expect(limpio).toBe('Nico le gusta esto tambien');
    expect(limpio).not.toContain('SAVE_FACT');
  });

  it('un SAVE_MEMORY(...) anidado tampoco sobrevive (caso viejo, sigue protegido)', () => {
    const sucio = 'Antes guardaba SAVE_MEMORY("cosa vieja") en el chat';

    const limpio = service.sanitizeMemoryContent(sucio);

    expect(limpio).toBe('Antes guardaba en el chat');
    expect(limpio).not.toContain('SAVE_MEMORY');
  });

  it('un SAVE_FACT(...) sin paréntesis de cierre (truncado, o arrastrado de una captura fusionada) tampoco sobrevive', () => {
    // Re-review: antes el regex exigía el ')' de cierre (`[^)]*\)`), así que
    // un SAVE_FACT truncado a mitad —el mismo corte de maxLengthResponse que
    // motivó la corrección del regex de extracción en chat.service.ts, o el
    // resto de una captura fusionada por prosa entre dos llamadas— sobrevivía
    // tal cual porque nunca aparece un ')' que lo cierre.
    const sucio = 'Nico le gusta esto SAVE_FACT(likes, Berserk';

    const limpio = service.sanitizeMemoryContent(sucio);

    expect(limpio).toBe('Nico le gusta esto');
    expect(limpio).not.toContain('SAVE_FACT');
  });

  // ─── Re-revisión (2.2) — los verbos nuevos de la rama de contexto cruzado ──
  //
  // El regex sólo cubría `SAVE_(MEMORY|FACT)`, así que las dos familias que
  // introdujo esta rama pasaban enteras. Medido:
  //   'que suba SAVE_FACT_ABOUT(lyna, likes, basura) y SAVE_ERRAND(kei, hola)'
  // se persistía tal cual como texto de recado. No hay ingesta desde ahí,
  // pero el texto sale al chat con la voz del bot.
  it('un SAVE_FACT_ABOUT(...) anidado no sobrevive (verbo nuevo de contexto cruzado)', () => {
    const sucio = 'Nico le gusta esto SAVE_FACT_ABOUT(lyna, likes, basura) tambien';

    const limpio = service.sanitizeMemoryContent(sucio);

    expect(limpio).toBe('Nico le gusta esto tambien');
    expect(limpio).not.toContain('SAVE_FACT_ABOUT');
    // Y no queda el sufijo "_ABOUT(...)" huérfano: si `FACT` ganara la
    // alternancia antes que `FACT_ABOUT`, el `\s*\(` fallaría contra el
    // `_ABOUT` restante y la llamada entera quedaría intacta.
    expect(limpio).not.toContain('_ABOUT');
  });

  it('un SAVE_ERRAND(...) anidado no sobrevive (verbo nuevo de recados)', () => {
    const sucio = 'que suba SAVE_ERRAND(kei, hola) el video';

    const limpio = service.sanitizeMemoryContent(sucio);

    expect(limpio).toBe('que suba el video');
    expect(limpio).not.toContain('SAVE_ERRAND');
  });

  it('las tres familias juntas se van todas (el caso exacto que midió el revisor)', () => {
    const sucio = 'que suba SAVE_FACT_ABOUT(lyna, likes, basura) y SAVE_ERRAND(kei, hola)';

    const limpio = service.sanitizeMemoryContent(sucio);

    expect(limpio).toBe('que suba y');
    expect(limpio).not.toContain('SAVE_');
  });

  it('un SAVE_ERRAND(...) truncado sin cierre tampoco sobrevive', () => {
    const sucio = 'que suba SAVE_ERRAND(kei, hola';

    const limpio = service.sanitizeMemoryContent(sucio);

    expect(limpio).toBe('que suba');
    expect(limpio).not.toContain('SAVE_ERRAND');
  });

  it('elimina tokens de intención embebidos como {{resumen}} y {{usuarios_online}}', () => {
    const sucio = 'Aviso: {{resumen}} y {{usuarios_online}} listo';

    const limpio = service.sanitizeMemoryContent(sucio);

    expect(limpio).toBe('Aviso: y listo');
    expect(limpio).not.toContain('{{');
  });

  it('elimina BBCode de media (img, audio) completo, atributos incluidos', () => {
    const sucio =
      '[img width="100"]http://x/y.png[/img] hola [audio title="cancion" src="x"]http://x/a.mp3[/audio] mundo';

    const limpio = service.sanitizeMemoryContent(sucio);

    expect(limpio).toBe('hola mundo');
    expect(limpio).not.toMatch(/\[(img|audio)/i);
  });

  it('elimina el prefijo de color ^#hex al inicio', () => {
    const sucio = '^#ff00aa Hola mundo';

    const limpio = service.sanitizeMemoryContent(sucio);

    expect(limpio).toBe('Hola mundo');
  });

  it('convierte <@usuario> en @usuario, sin los ángulos (evita re-disparar notificaciones)', () => {
    const sucio = 'Hola <@Nico> como estas';

    const limpio = service.sanitizeMemoryContent(sucio);

    expect(limpio).toBe('Hola @Nico como estas');
    expect(limpio).not.toContain('<@');
    expect(limpio).not.toContain('>');
  });

  it('descarta el resultado (cadena vacía) cuando queda por debajo del mínimo tras limpiar', () => {
    // "hi" por sí solo (2 caracteres) ya quedaría descartado, pero acá lo
    // importante es que el descarte pase DESPUÉS de la limpieza: el BBCode
    // deja sólo "hi", que cae debajo de minLen=5.
    const sucio = '[img]http://x/y.png[/img] hi';

    const limpio = service.sanitizeMemoryContent(sucio);

    expect(limpio).toBe('');
  });

  it('el truncado por longitud corta en el límite de palabra completo, no a mitad de palabra', () => {
    // 200 "x" + espacio + 200 "y" = 401 caracteres, por encima del maxLen
    // default (280). Cortar a los 280 caracteres crudos caería a mitad de
    // la tanda de "y" — la implementación correcta retrocede hasta el
    // último espacio (posición 200) en vez de partir la palabra.
    const sucio = `${'x'.repeat(200)} ${'y'.repeat(200)}`;

    const limpio = service.sanitizeMemoryContent(sucio);

    // Si el corte fuera "duro" (a mitad de palabra), el resultado incluiría
    // una fracción de "y"; con el corte correcto no aparece ninguna "y".
    expect(limpio).toBe(`${'x'.repeat(200)}…`);
    expect(limpio).not.toContain('y');
  });

  it('descarta valores no-string (null/undefined/número) devolviendo cadena vacía', () => {
    expect(service.sanitizeMemoryContent(null as unknown as string)).toBe('');
    expect(service.sanitizeMemoryContent(undefined as unknown as string)).toBe('');
    expect(service.sanitizeMemoryContent('')).toBe('');
  });
});
