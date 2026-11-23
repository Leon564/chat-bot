/**
 * Fechas en hora de El Salvador: UTC-6 fijo, sin horario de verano (mismo
 * criterio que `ReminderService`). Las fechas de los recuerdos se guardan
 * como `YYYY-MM-DD` local, así que comparar strings alcanza para ordenar.
 */
const OFFSET_MS = 6 * 60 * 60_000;

/** `YYYY-MM-DD` del día local de `now`. */
export function localDayKey(now: Date): string {
  return new Date(now.getTime() - OFFSET_MS).toISOString().slice(0, 10);
}

/** Fecha local (`YYYY-MM-DD`) + hora local (`HH:mm`) → instante UTC. */
export function localToUtc(day: string, time: string): Date {
  return new Date(new Date(`${day}T${time}:00.000Z`).getTime() + OFFSET_MS);
}

/** Suma días a una fecha local `YYYY-MM-DD`. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
