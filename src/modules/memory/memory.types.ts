/** Tipos de recuerdo. `event` lleva fecha y puede tener seguimientos. */
export type MemoryKind = 'event' | 'fact' | 'shared';

export const MEMORY_KINDS: MemoryKind[] = ['event', 'fact', 'shared'];

/** Un recuerdo ya validado, listo para guardar. */
export interface MemoryDraft {
  kind: MemoryKind;
  /** Una frase en tercera persona, máx. 200 caracteres. */
  text: string;
  /** 3–6 palabras clave en minúscula y sin acentos (piso de la búsqueda). */
  keywords: string[];
  /** `YYYY-MM-DD` (hora de El Salvador). Sólo `event`. */
  eventDate?: string;
  /** `HH:mm` (hora de El Salvador). Sólo `event`. */
  eventTime?: string;
  /** Salud, familia, plata: nunca se menciona en público por iniciativa propia. */
  sensitive: boolean;
}

/** Roles con memoria a largo plazo: los registrados. */
export const MEMORY_ROLES: ReadonlySet<string> = new Set(['user', 'mod', 'admin', 'superAdmin']);
