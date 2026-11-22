import { ConfigService } from '@nestjs/config';
import { VideoSettingsService } from './video-settings.service';

const buildService = (envValue: boolean | undefined): VideoSettingsService => {
  const config = {
    get: (key: string) => (key === 'video.enabled' ? envValue : undefined),
  } as unknown as ConfigService;
  return new VideoSettingsService(config);
};

describe('VideoSettingsService', () => {
  it('sin override refleja el .env (ausente = apagado)', () => {
    expect(buildService(true).isEnabled()).toBe(true);
    expect(buildService(false).isEnabled()).toBe(false);
    expect(buildService(undefined).isEnabled()).toBe(false);
  });

  it('el override gana en ambas direcciones y null vuelve al .env', () => {
    const service = buildService(false);
    service.setOverride(true);
    expect(service.getInfo()).toEqual({ enabled: true, source: 'override' });
    service.setOverride(null);
    expect(service.getInfo()).toEqual({ enabled: false, source: 'env' });

    const on = buildService(true);
    on.setOverride(false);
    expect(on.isEnabled()).toBe(false);
  });
});
