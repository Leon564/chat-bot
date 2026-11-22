import { ConfigService } from '@nestjs/config';
import { VideoSettingsService } from './video-settings.service';

const buildService = (env: Record<string, unknown> = {}): VideoSettingsService => {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new VideoSettingsService(config);
};

describe('VideoSettingsService', () => {
  it('sin override refleja el .env (ausente = apagado)', () => {
    expect(buildService({ 'video.enabled': true }).isEnabled()).toBe(true);
    expect(buildService({ 'video.enabled': false }).isEnabled()).toBe(false);
    expect(buildService().isEnabled()).toBe(false);
  });

  it('el override gana en ambas direcciones y null vuelve al .env', () => {
    const service = buildService({ 'video.enabled': false });
    service.setOverride(true);
    expect(service.getInfo()).toMatchObject({ enabled: true, source: 'override' });
    service.setOverride(null);
    expect(service.getInfo()).toMatchObject({ enabled: false, source: 'env' });

    const on = buildService({ 'video.enabled': true });
    on.setOverride(false);
    expect(on.isEnabled()).toBe(false);
  });

  it('el modo por default es youtube; sólo "upload" en el .env sube archivos', () => {
    expect(buildService().getMode()).toBe('youtube');
    expect(buildService({ 'video.mode': 'cualquiera' }).getMode()).toBe('youtube');
    expect(buildService({ 'video.mode': 'upload' }).getMode()).toBe('upload');
  });

  it('el override de modo es independiente del de habilitado', () => {
    const service = buildService({ 'video.enabled': true });
    service.setModeOverride('upload');
    expect(service.getInfo()).toEqual({ enabled: true, source: 'env', mode: 'upload', modeSource: 'override' });
    service.setModeOverride(null);
    expect(service.getInfo()).toMatchObject({ mode: 'youtube', modeSource: 'env' });
  });
});
