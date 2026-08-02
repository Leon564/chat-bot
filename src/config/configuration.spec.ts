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
