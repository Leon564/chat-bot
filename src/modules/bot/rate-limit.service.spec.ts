import { ConfigService } from '@nestjs/config';
import { RateLimitService } from './rate-limit.service';

/**
 * `RateLimitService` no depende de Mongo, sólo de `ConfigService` —
 * instanciación directa, mismo criterio que `UtilsService` (ver
 * `utils.service.spec.ts`). Usa temporizadores falsos de Jest en vez del
 * reloj real: la ventana móvil es de una hora, y avanzarla de verdad haría
 * el test lento y frágil (dependería de cuánto tarda en correr la suite).
 */
describe('RateLimitService', () => {
  let config: { get: jest.Mock };
  let service: RateLimitService;

  beforeEach(() => {
    jest.useFakeTimers();
    config = { get: jest.fn() };
    service = new RateLimitService(config as unknown as ConfigService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const conLimite = (n: number) => {
    config.get.mockImplementation((key: string) =>
      key === 'bot.rateLimitPerHour' ? n : undefined,
    );
  };

  it('permite las primeras N llamadas y rechaza la N+1', () => {
    conLimite(3);

    expect(service.check('Nico')).toBe(true);
    expect(service.check('Nico')).toBe(true);
    expect(service.check('Nico')).toBe(true);
    expect(service.check('Nico')).toBe(false);
  });

  it('la ventana es móvil: pasada una hora vuelve a permitir', () => {
    conLimite(2);

    expect(service.check('Nico')).toBe(true);
    expect(service.check('Nico')).toBe(true);
    expect(service.check('Nico')).toBe(false);

    // Avanzamos una hora y un segundo: las dos marcas anteriores quedan
    // fuera de la ventana móvil.
    jest.advanceTimersByTime(60 * 60 * 1000 + 1000);

    expect(service.check('Nico')).toBe(true);
  });

  it('cuenta por usuario: el tope de uno no afecta a otro', () => {
    conLimite(1);

    expect(service.check('Nico')).toBe(true);
    expect(service.check('Nico')).toBe(false);

    // Kei no gastó nada de su propio cupo todavía.
    expect(service.check('Kei')).toBe(true);
    expect(service.check('Kei')).toBe(false);
  });

  it('admin y superAdmin nunca se limitan', () => {
    conLimite(1);

    expect(service.check('Nico', 'admin')).toBe(true);
    expect(service.check('Nico', 'admin')).toBe(true);
    expect(service.check('Nico', 'admin')).toBe(true);

    expect(service.check('Kei', 'superAdmin')).toBe(true);
    expect(service.check('Kei', 'superAdmin')).toBe(true);
  });

  it('el conteo tolera mayúsculas y espacios en el nombre', () => {
    conLimite(1);

    expect(service.check('Nico')).toBe(true);
    // Mismo usuario, distinta capitalización y con espacios alrededor: debe
    // seguir contando contra el mismo cupo, no abrir uno nuevo.
    expect(service.check(' NICO ')).toBe(false);
    expect(service.check('nico')).toBe(false);
  });

  it('con el límite en 0 no se limita a nadie (desactivado)', () => {
    conLimite(0);

    for (let i = 0; i < 50; i++) {
      expect(service.check('Nico')).toBe(true);
    }
  });

  describe('shouldNotifyRejection (Important #2 — cooldown del aviso, no del límite)', () => {
    it('avisa la primera vez y calla las siguientes dentro del cooldown', () => {
      expect(service.shouldNotifyRejection('Nico')).toBe(true);
      expect(service.shouldNotifyRejection('Nico')).toBe(false);
      expect(service.shouldNotifyRejection('Nico')).toBe(false);
    });

    it('pasados 5 minutos vuelve a avisar', () => {
      expect(service.shouldNotifyRejection('Nico')).toBe(true);
      expect(service.shouldNotifyRejection('Nico')).toBe(false);

      jest.advanceTimersByTime(5 * 60 * 1000 + 1000);

      expect(service.shouldNotifyRejection('Nico')).toBe(true);
    });

    it('el cooldown es por usuario: uno no calla al otro', () => {
      expect(service.shouldNotifyRejection('Nico')).toBe(true);
      expect(service.shouldNotifyRejection('Nico')).toBe(false);

      expect(service.shouldNotifyRejection('Kei')).toBe(true);
    });

    it('tolera mayúsculas y espacios, igual que check()', () => {
      expect(service.shouldNotifyRejection('Nico')).toBe(true);
      expect(service.shouldNotifyRejection(' NICO ')).toBe(false);
    });
  });
});
