import configuration from './configuration';

/**
 * Cubre específicamente `rateLimitPerHour` (Important #3 de la revisión
 * final): un `RATE_LIMIT_PER_HOUR` no numérico en el `.env` debía dejar el
 * guard de costo desactivado en silencio, porque `parseInt('abc', 10)` da
 * `NaN`, y ni `NaN ?? 20` (no es nullish) ni `NaN <= 0` (es `false`) lo
 * atrapaban — y `fresh.length >= NaN` es `false` siempre, así que el límite
 * nunca se aplicaba, sin loguear nada.
 */
describe('configuration — bot.rateLimitPerHour', () => {
  const ORIGINAL_ENV = process.env.RATE_LIMIT_PER_HOUR;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.RATE_LIMIT_PER_HOUR;
    else process.env.RATE_LIMIT_PER_HOUR = ORIGINAL_ENV;
  });

  it('usa el default (20) cuando la variable no está seteada', () => {
    delete process.env.RATE_LIMIT_PER_HOUR;
    expect(configuration().bot.rateLimitPerHour).toBe(20);
  });

  it('parsea un valor numérico válido', () => {
    process.env.RATE_LIMIT_PER_HOUR = '5';
    expect(configuration().bot.rateLimitPerHour).toBe(5);
  });

  it('cae al default cuando el valor no es numérico, en vez de producir NaN', () => {
    process.env.RATE_LIMIT_PER_HOUR = 'abc';
    expect(configuration().bot.rateLimitPerHour).toBe(20);
    expect(Number.isNaN(configuration().bot.rateLimitPerHour)).toBe(false);
  });

  it('cae al default cuando el valor es una cadena vacía', () => {
    process.env.RATE_LIMIT_PER_HOUR = '';
    expect(configuration().bot.rateLimitPerHour).toBe(20);
  });

  it('conserva 0 (interruptor de "desactivado"), no lo confunde con un valor inválido', () => {
    process.env.RATE_LIMIT_PER_HOUR = '0';
    expect(configuration().bot.rateLimitPerHour).toBe(0);
  });
});

/**
 * `CROSS_USER_CONTEXT` es el único interruptor de toda la rama de contexto
 * cruzado y se lee con una comparación estricta `=== 'true'`
 * (`configuration.ts`). Sin estos tests se podía publicar una build donde
 * encender el flag en el `.env` no hiciera nada —un `CROSS_USER_CONTEXT=1` o
 * `=TRUE` deja el flag apagado— con la suite completamente en verde.
 */
describe('configuration — bot.crossUserContext', () => {
  const ORIGINAL_ENV = process.env.CROSS_USER_CONTEXT;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CROSS_USER_CONTEXT;
    else process.env.CROSS_USER_CONTEXT = ORIGINAL_ENV;
  });

  it('está apagado cuando la variable no está seteada (default opt-in)', () => {
    delete process.env.CROSS_USER_CONTEXT;
    expect(configuration().bot.crossUserContext).toBe(false);
  });

  it("se enciende SÓLO con el literal 'true'", () => {
    process.env.CROSS_USER_CONTEXT = 'true';
    expect(configuration().bot.crossUserContext).toBe(true);
  });

  it('queda apagado con cualquier otro valor verdadero-parecido', () => {
    for (const valor of ['1', 'TRUE', 'True', 'yes', 'on', ' true ']) {
      process.env.CROSS_USER_CONTEXT = valor;
      expect(configuration().bot.crossUserContext).toBe(false);
    }
  });

  it("queda apagado con 'false' y con cadena vacía", () => {
    process.env.CROSS_USER_CONTEXT = 'false';
    expect(configuration().bot.crossUserContext).toBe(false);
    process.env.CROSS_USER_CONTEXT = '';
    expect(configuration().bot.crossUserContext).toBe(false);
  });
});
