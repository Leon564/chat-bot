import { MemoryDraft, MemoryKind } from './memory.types';
import { addDays, localDayKey } from './memory-time';

/**
 * Verbos con los que el modelo maneja la memoria:
 *   RECUERDO(tipo | texto | claves | fecha | hora | delicado)
 *   RECUERDO_CAMBIO(id | fecha [| hora])
 *   RECUERDO_CERRADO(id)
 * Los campos van separados por `|` porque los textos llevan comas. Todo acá
 * es puro (sin Mongo ni modelo) para poder testearlo directo.
 */

/** Para sumar a la barrida final de verbos sueltos (`ResponseVerbs`). */
export const MEMORY_VERB_PATTERN_SOURCE = '\\bRECUERDO(?:_CAMBIO|_CERRADO)?\\s*\\(';

// Sólo en MAYÚSCULAS: "un recuerdo (de cuando…)" es charla, no un verbo.
const HEAD_RE = /\bRECUERDO(_CAMBIO|_CERRADO)?\s*\(/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const REF_RE = /^r\d+$/i;
const MAX_TEXT = 200;
const MAX_KEYWORDS = 6;

const KIND_ALIASES: Record<string, MemoryKind> = {
  evento: 'event',
  event: 'event',
  dato: 'fact',
  fact: 'fact',
  compartido: 'shared',
  shared: 'shared',
};

const stripAccents = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const fieldsOf = (raw: string): string[] => raw.split('|').map((f) => f.trim());

export interface MemoryVerbs {
  content: string;
  /** Campos crudos de cada RECUERDO, sin validar. */
  saves: string[][];
  changes: { ref: string; eventDate: string; eventTime?: string }[];
  closes: string[];
}

/**
 * Saca los tres verbos del texto (contando paréntesis, como
 * `ResponseVerbs.extractInstructionVerbs`) y devuelve lo que pedían. Un verbo
 * sin cerrar se corta hasta el final. Sin verbos, el texto vuelve tal cual.
 */
export function extractMemoryVerbs(content: string): MemoryVerbs {
  const out: MemoryVerbs = { content, saves: [], changes: [], closes: [] };
  if (!content || !HEAD_RE.test(content)) return out;

  let rest = content;
  let kept = '';
  let m: RegExpExecArray | null;
  while ((m = HEAD_RE.exec(rest)) !== null) {
    kept += rest.slice(0, m.index);
    let i = m.index + m[0].length;
    let depth = 1;
    for (; i < rest.length && depth > 0; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')') depth--;
    }
    if (depth > 0) {
      rest = '';
      break;
    }
    const fields = fieldsOf(rest.slice(m.index + m[0].length, i - 1));
    const variant = (m[1] ?? '').toUpperCase();
    if (variant === '_CAMBIO') {
      const [ref, eventDate, eventTime] = fields;
      if (REF_RE.test(ref ?? '') && DATE_RE.test(eventDate ?? '')) {
        out.changes.push({ ref: ref.toLowerCase(), eventDate, ...(eventTime && TIME_RE.test(eventTime) ? { eventTime } : {}) });
      }
    } else if (variant === '_CERRADO') {
      if (REF_RE.test(fields[0] ?? '')) out.closes.push(fields[0].toLowerCase());
    } else {
      out.saves.push(fields);
    }
    rest = rest.slice(i);
  }
  kept += rest;
  out.content = kept.replace(/[ \t]{2,}/g, ' ').trim();
  return out;
}

/** true si `day` es una fecha real del calendario (`2026-02-30` no). */
function isRealDate(day: string): boolean {
  if (!DATE_RE.test(day)) return false;
  const d = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/**
 * Convierte los campos de un RECUERDO en un `MemoryDraft`, o `null` si no
 * sirve (tipo desconocido, texto vacío). Un evento sin fecha válida (relativa,
 * mal formada, anterior a ayer o a más de un año) se guarda como dato: el
 * recuerdo vale igual, pero sin fecha no puede tener seguimientos.
 */
export function validateMemoryDraft(fields: string[], now: Date): MemoryDraft | null {
  const [rawKind, rawText, rawKeywords, rawDate, rawTime, rawSensitive] = fields.map((f) => (f ?? '').trim());
  let kind = KIND_ALIASES[stripAccents((rawKind ?? '').toLowerCase())];
  const text = (rawText ?? '').slice(0, MAX_TEXT).trim();
  if (!kind || !text) return null;

  const keywords = (rawKeywords ?? '')
    .split(',')
    .map((k) => stripAccents(k).toLowerCase().trim())
    .filter(Boolean)
    .slice(0, MAX_KEYWORDS);
  const sensitive = /^(si|yes|true)$/.test(stripAccents((rawSensitive ?? '').toLowerCase()));

  const draft: MemoryDraft = { kind, text, keywords, sensitive };
  if (kind !== 'event') return draft;

  const today = localDayKey(now);
  const latest = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
  const date = rawDate ?? '';
  if (!isRealDate(date) || date < addDays(today, -1) || date > latest) {
    kind = 'fact';
    return { ...draft, kind };
  }
  draft.eventDate = date;
  if (TIME_RE.test(rawTime ?? '')) draft.eventTime = rawTime;
  return draft;
}
