import { ProactiveService } from './proactive.service';

describe('ProactiveService', () => {
  const build = (config: Record<string, unknown> = { 'bot.proactiveChance': 0.1, 'bot.proactiveCooldownMinutes': 15 }) => {
    const service = new ProactiveService({ get: (k: string) => config[k] } as any);
    let now = 1_000_000_000;
    service.now = () => now;
    service.random = () => 0;
    return { service, advance: (ms: number) => (now += ms) };
  };

  const charla = 'alguien vio el capítulo nuevo de Frieren?';

  it('intenta con un mensaje con contenido si sale el dado', () => {
    const { service } = build();
    expect(service.shouldTry(charla)).toBe(true);
  });

  it.each(['jaja', '!quesabes algo largo', '/wordle hoy está difícil', ':stk_gato1:'])(
    'no intenta con "%s"',
    (msg) => {
      expect(build().service.shouldTry(msg)).toBe(false);
    },
  );

  it('respeta la probabilidad', () => {
    const { service } = build();
    service.random = () => 0.5;
    expect(service.shouldTry(charla)).toBe(false);
  });

  it('después de un intento espera la pausa, hable o no', () => {
    const { service, advance } = build();
    service.markAttempt();
    expect(service.shouldTry(charla)).toBe(false);
    advance(14 * 60_000);
    expect(service.shouldTry(charla)).toBe(false);
    advance(2 * 60_000);
    expect(service.shouldTry(charla)).toBe(true);
  });

  it('con probabilidad 0 está apagado, salvo override en runtime', () => {
    const { service } = build({ 'bot.proactiveChance': 0 });
    expect(service.shouldTry(charla)).toBe(false);
    service.setOverride(true);
    expect(service.shouldTry(charla)).toBe(true);
    service.setOverride(false);
    expect(service.isEnabled()).toBe(false);
    service.setOverride(null);
    expect(service.getInfo()).toEqual(expect.objectContaining({ enabled: false, source: 'env' }));
  });

  it('isLively exige varios mensajes de varias personas, sin contar al bot', () => {
    const fila = (user: string) => ({ user, message: 'x' });
    expect(ProactiveService.isLively([fila('kei'), fila('lyna'), fila('kei'), fila('lyna')], 'Aria')).toBe(true);
    expect(ProactiveService.isLively([fila('kei'), fila('kei'), fila('kei'), fila('kei')], 'Aria')).toBe(false);
    expect(ProactiveService.isLively([fila('kei'), fila('lyna'), fila('Aria'), fila('Aria')], 'Aria')).toBe(false);
  });
});
