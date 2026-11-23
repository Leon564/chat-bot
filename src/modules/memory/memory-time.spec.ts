import { localDayKey, localToUtc } from './memory-time';

describe('memory-time (hora de El Salvador, UTC-6 fijo)', () => {
  it('localDayKey da la fecha local', () => {
    expect(localDayKey(new Date('2026-11-22T16:00:00Z'))).toBe('2026-11-22');
    // 23:30 local del 22 sigue siendo el 22.
    expect(localDayKey(new Date('2026-11-23T05:30:00Z'))).toBe('2026-11-22');
    expect(localDayKey(new Date('2026-11-23T06:00:00Z'))).toBe('2026-11-23');
  });

  it('localToUtc convierte fecha y hora local a UTC', () => {
    expect(localToUtc('2026-11-27', '09:00').toISOString()).toBe('2026-11-27T15:00:00.000Z');
    expect(localToUtc('2026-11-27', '00:00').toISOString()).toBe('2026-11-27T06:00:00.000Z');
    expect(localToUtc('2026-12-31', '23:30').toISOString()).toBe('2027-01-01T05:30:00.000Z');
  });
});
