const fetchMock = jest.fn();
jest.mock('node-fetch', () => ({ __esModule: true, default: (...args: unknown[]) => fetchMock(...args) }));

import { AniListService, ANILIST_TIMEOUT_MS } from './anilist.service';

describe('AniListService — timeout', () => {
  const service = new AniListService();

  beforeEach(() => {
    fetchMock.mockReset();
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});
  });

  it('manda una señal con el timeout configurado', async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: async () => ({ data: { Media: null } }) });
    await service.search('manga', 'Berserk');
    const opts = fetchMock.mock.calls[0][1];
    expect(opts.signal).toBeDefined();
    expect(ANILIST_TIMEOUT_MS).toBe(10_000);
  });

  it('si vence la señal al pedir, falla con TIMEOUT (no NETWORK)', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    await expect(service.search('manga', 'Berserk')).rejects.toThrow('TIMEOUT');
  });

  it('si vence mientras lee el cuerpo, también es TIMEOUT', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
    await expect(service.search('manga', 'Berserk')).rejects.toThrow('TIMEOUT');
  });

  it('otros errores de red siguen siendo NETWORK', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(service.search('manga', 'Berserk')).rejects.toThrow('NETWORK');
  });
});
