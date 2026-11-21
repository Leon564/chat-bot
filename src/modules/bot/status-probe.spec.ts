import { probe, formatProbe, formatUptime } from './status-probe';

describe('status-probe', () => {
  const clock = () => {
    let t = 1000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('una respuesta HTTP < 500 cuenta como viva, con el tiempo', async () => {
    const c = clock();
    const doFetch = jest.fn(async () => {
      c.advance(240);
      return { status: 404 };
    });
    const r = await probe('modelo', 'https://x', doFetch as any, c.now);
    expect(r).toEqual({ name: 'modelo', ok: true, ms: 240, detail: '404' });
    expect(formatProbe(r)).toBe('modelo ✅ 240 ms');
    expect((doFetch.mock.calls[0] as any)[1].signal).toBeDefined();
  });

  it('un 5xx responde pero con problemas', async () => {
    const r = await probe('FileGarden', 'https://x', (async () => ({ status: 503 })) as any);
    expect(r.ok).toBe(false);
    expect(formatProbe(r)).toBe('FileGarden ⚠️ 503');
  });

  it('timeout y error de red', async () => {
    const timeout = await probe('catbox', 'https://x', (async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as any);
    expect(formatProbe(timeout)).toBe('catbox ❌ timeout');
    const net = await probe('AniList', 'https://x', (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as any);
    expect(formatProbe(net)).toBe('AniList ❌ getaddrinfo ENOTFOUND');
    expect(formatProbe(await probe('chat', ''))).toBe('chat ❌ sin configurar');
  });

  it('formatUptime', () => {
    expect(formatUptime(240)).toBe('4 min');
    expect(formatUptime(3 * 3600 + 12 * 60)).toBe('3 h 12 min');
    expect(formatUptime(2 * 86400 + 5 * 3600)).toBe('2 d 5 h');
  });
});
