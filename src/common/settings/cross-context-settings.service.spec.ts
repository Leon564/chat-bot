import { ConfigService } from '@nestjs/config';
import { CrossContextSettingsService } from './cross-context-settings.service';

const buildService = (envValue: boolean): CrossContextSettingsService => {
  const config = {
    get: (key: string) => (key === 'bot.crossUserContext' ? envValue : undefined),
  } as unknown as ConfigService;
  return new CrossContextSettingsService(config);
};

describe('CrossContextSettingsService', () => {
  it('sin override, refleja el valor del .env', () => {
    expect(buildService(false).isEnabled()).toBe(false);
    expect(buildService(true).isEnabled()).toBe(true);
  });

  it('el override gana sobre el .env, en ambas direcciones', () => {
    const offInEnv = buildService(false);
    offInEnv.setOverride(true);
    expect(offInEnv.isEnabled()).toBe(true);

    const onInEnv = buildService(true);
    onInEnv.setOverride(false);
    expect(onInEnv.isEnabled()).toBe(false);
  });

  it('setOverride(null) vuelve al valor del .env', () => {
    const service = buildService(true);
    service.setOverride(false);
    service.setOverride(null);
    expect(service.isEnabled()).toBe(true);
    expect(service.getInfo()).toEqual({ enabled: true, source: 'env' });
  });

  it('getInfo distingue la fuente del valor', () => {
    const service = buildService(false);
    expect(service.getInfo()).toEqual({ enabled: false, source: 'env' });
    service.setOverride(true);
    expect(service.getInfo()).toEqual({ enabled: true, source: 'override' });
  });

  it('un .env ausente cuenta como apagado', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    expect(new CrossContextSettingsService(config).isEnabled()).toBe(false);
  });
});
