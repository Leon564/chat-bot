import { MusicQuotaService, MAX_PENDING_PER_USER, MAX_PENDING_GLOBAL } from './music-quota.service';

class Clocked extends MusicQuotaService {
  t = 1_000_000;
  protected now(): number {
    return this.t;
  }
}

const build = (perHour = 5, perHourRegistered = 20, extra: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = {
    'music.perHour': perHour,
    'music.perHourRegistered': perHourRegistered,
    ...extra,
  };
  return new Clocked({ get: (k: string) => values[k] } as never);
};

describe('MusicQuotaService', () => {
  it(`deja ${MAX_PENDING_PER_USER} pedidos en camino por persona y libera al terminar`, () => {
    const q = build();
    const a = q.admit('nico', 'user');
    const b = q.admit('NICO', 'user'); // mismo nombre, sin distinguir mayúsculas
    expect(a.ok && b.ok).toBe(true);

    expect(q.admit('nico', 'user')).toEqual({ ok: false, reason: 'user_pending', limit: MAX_PENDING_PER_USER });
    expect(q.admit('kei', 'user').ok).toBe(true); // otra persona no se ve afectada

    if (a.ok) {
      a.release();
      a.release(); // idempotente: no libera dos lugares
    }
    expect(q.admit('nico', 'user').ok).toBe(true);
    expect(q.admit('nico', 'user').ok).toBe(false);
  });

  it(`no pasa de ${MAX_PENDING_GLOBAL} en todo el chat, tampoco para el staff`, () => {
    const q = build(0, 0);
    for (let i = 0; i < MAX_PENDING_GLOBAL; i++) expect(q.admit(`u${i}`, 'admin').ok).toBe(true);
    expect(q.admit('otro', 'admin')).toEqual({ ok: false, reason: 'global_pending', limit: MAX_PENDING_GLOBAL });
  });

  it('cupo por hora de invitados, en ventana móvil', () => {
    const q = build(2, 20);
    const take = () => {
      const r = q.admit('invitado', 'guest');
      if (r.ok) r.release();
      return r;
    };
    expect(take().ok).toBe(true);
    expect(take().ok).toBe(true);
    expect(take()).toEqual({ ok: false, reason: 'hourly', limit: 2 });

    q.t += 60 * 60_000; // pasa una hora desde los dos primeros
    expect(take().ok).toBe(true);
  });

  it('sin rol cuenta como invitado; user tiene su propio cupo; staff sin cupo', () => {
    const q = build(1, 3);
    const take = (name: string, role?: string) => {
      const r = q.admit(name, role);
      if (r.ok) r.release();
      return r.ok;
    };
    expect([take('a'), take('a')]).toEqual([true, false]);
    expect([take('b', 'user'), take('b', 'user'), take('b', 'user'), take('b', 'user')]).toEqual([true, true, true, false]);
    expect(Array.from({ length: 30 }, () => take('m', 'mod')).every(Boolean)).toBe(true);
  });

  it('los topes de "en camino" salen del .env', () => {
    const q = build(0, 0, { 'music.maxPendingPerUser': 1, 'music.maxPendingGlobal': 3 });
    expect(q.admit('nico').ok).toBe(true);
    expect(q.admit('nico')).toEqual({ ok: false, reason: 'user_pending', limit: 1 });
    expect(q.admit('kei').ok).toBe(true);
    expect(q.admit('lyna').ok).toBe(true);
    expect(q.admit('otro')).toEqual({ ok: false, reason: 'global_pending', limit: 3 });
  });

  it('topes de "en camino" en 0 = sin tope', () => {
    const q = build(0, 0, { 'music.maxPendingPerUser': 0, 'music.maxPendingGlobal': 0 });
    for (let i = 0; i < 30; i++) expect(q.admit('nico').ok).toBe(true);
  });

  it('un cupo en 0 desactiva esa regla', () => {
    const q = build(0, 0);
    for (let i = 0; i < 50; i++) {
      const r = q.admit('invitado', 'guest');
      expect(r.ok).toBe(true);
      if (r.ok) r.release();
    }
  });

  it('un rechazo por cupo no consume el cupo', () => {
    const q = build(1, 20);
    const first = q.admit('x', 'guest');
    if (first.ok) first.release();
    expect(q.admit('x', 'guest').ok).toBe(false);
    q.t += 60 * 60_000 + 1;
    expect(q.admit('x', 'guest').ok).toBe(true);
  });
});
