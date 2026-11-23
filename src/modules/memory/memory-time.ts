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

const HOUR_MS = 60 * 60_000;
/** Antes de esta hora local no se le escribe a nadie por un evento. */
const EARLIEST = '08:00';
/** Margen mínimo entre el aviso y el evento. */
const MIN_LEAD_MS = 30 * 60_000;

/**
 * Cuándo sale la suerte del día de un evento: sin hora, 09:00 local; con
 * hora, 2 h antes, pero no antes de las 08:00. Un evento que empieza antes de
 * las 08:30 no tiene aviso (`null`): sería mencionar a alguien de madrugada.
 */
export function beforeDueAt(eventDate: string, eventTime?: string): Date | null {
  if (!eventTime) return localToUtc(eventDate, '09:00');
  const start = localToUtc(eventDate, eventTime).getTime();
  const earliest = localToUtc(eventDate, EARLIEST).getTime();
  const twoHoursBefore = start - 2 * HOUR_MS;
  if (twoHoursBefore >= earliest) return new Date(twoHoursBefore);
  if (start - earliest >= MIN_LEAD_MS) return new Date(earliest);
  return null;
}

/** Ventana del "¿cómo te fue?": desde las 00:00 local del día siguiente, por 5 días. */
export function afterWindow(eventDate: string): { from: Date; expiresAt: Date } {
  const next = addDays(eventDate, 1);
  return { from: localToUtc(next, '00:00'), expiresAt: localToUtc(addDays(next, 5), '00:00') };
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** "viernes 27/11" o "viernes 27/11 15:00". */
export function formatEventDate(eventDate: string, eventTime?: string | null): string {
  const day = WEEKDAYS[new Date(`${eventDate}T12:00:00Z`).getUTCDay()];
  const [, mm, dd] = eventDate.split('-');
  return `${day} ${dd}/${mm}${eventTime ? ` ${eventTime}` : ''}`;
}
