import { afterWindow, beforeDueAt, localDayKey, localToUtc } from './memory-time';

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

describe('beforeDueAt / afterWindow', () => {
  it('sin hora: 09:00 local del día del evento', () => {
    expect(beforeDueAt('2026-11-27')?.toISOString()).toBe('2026-11-27T15:00:00.000Z');
  });

  it('con hora: 2 h antes', () => {
    expect(beforeDueAt('2026-11-27', '15:00')?.toISOString()).toBe('2026-11-27T19:00:00.000Z');
  });

  it('con hora temprana: no antes de las 08:00', () => {
    expect(beforeDueAt('2026-11-27', '09:00')?.toISOString()).toBe('2026-11-27T14:00:00.000Z');
  });

  // Revisión final: no mencionar a nadie de madrugada.
  it('evento antes de las 08:30: sin aviso (null)', () => {
    expect(beforeDueAt('2026-11-27', '08:29')).toBeNull();
    expect(beforeDueAt('2026-11-27', '05:00')).toBeNull();
    expect(beforeDueAt('2026-11-27', '00:15')).toBeNull();
  });

  it('evento a las 08:30: a las 08:00', () => {
    expect(beforeDueAt('2026-11-27', '08:30')?.toISOString()).toBe('2026-11-27T14:00:00.000Z');
  });

  it('el después: desde las 00:00 del día siguiente, por 5 días', () => {
    const w = afterWindow('2026-11-27');
    expect(w.from.toISOString()).toBe('2026-11-28T06:00:00.000Z');
    expect(w.expiresAt.toISOString()).toBe('2026-12-03T06:00:00.000Z');
  });
});
