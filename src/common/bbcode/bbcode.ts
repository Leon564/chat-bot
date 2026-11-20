/**
 * BBCodes de formato del chat, del lado del bot.
 *
 * `FORMAT_BBCODES`, `normalizeDisabledBbcodes`, `findEmptyBbcode` e
 * `isOnlyCaretColor` son copia del gemelo del chat
 * (`backend/src/chat/bbcode.ts` ↔ `frontend/src/lib/bbcode.ts`). El bot es
 * otro repo y no puede importarlo: si allá se agrega un tag o cambia la regla
 * de "BBCode vacío", hay que replicarlo acá. Contexto completo en
 * `docs/bbcode-contexto.md`.
 *
 * Lo demás es propio del bot:
 *   - `sanitizeBotBbcode`: red de seguridad antes de enviar (tags vacíos,
 *     apagados, inválidos o desbalanceados). Un BBCode vacío hace que el
 *     backend DESCARTE EN SILENCIO el mensaje entero.
 *   - `rebalanceBbcodeParts`: cierra y reabre los tags abiertos cuando un
 *     mensaje largo se parte en varios.
 *   - `bbcodeToPlain`: texto legible para el modelo / la memoria.
 */

export const FORMAT_BBCODES = [
  'b',
  'i',
  'u',
  's',
  'url',
  'quote',
  'code',
  'color',
  'spoiler',
  'big',
  'scroll',
  'shake',
] as const;

export type FormatBbcode = (typeof FORMAT_BBCODES)[number];

/** Filtra a nombres conocidos, en minúscula y sin repetidos. Lo que no sea un
 *  array de strings queda como "nada apagado". */
export function normalizeDisabledBbcodes(input: unknown): FormatBbcode[] {
  if (!Array.isArray(input)) return [];
  const known = new Set<string>(FORMAT_BBCODES);
  const out = new Set<FormatBbcode>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (known.has(name)) out.add(name as FormatBbcode);
  }
  return Array.from(out);
}

const SIMPLE_TAGS = 'b|i|u|s|quote|code|spoiler|big|scroll|shake';

/** Un BBCode de formato sin contenido (sólo espacios entre las etiquetas). */
const EMPTY_BBCODE_SRC =
  `\\[(${SIMPLE_TAGS})\\]\\s*\\[\\/\\1\\]` +
  `|\\[(color)=#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\\]\\s*\\[\\/color\\]` +
  `|\\[(url)(?:=[^\\]\\s]*)?\\]\\s*\\[\\/url\\]`;
const EMPTY_BBCODE_RE = new RegExp(EMPTY_BBCODE_SRC, 'i');

/** Nombre del primer BBCode de formato vacío del mensaje, o `null`. */
export function findEmptyBbcode(content: string): FormatBbcode | null {
  const m = EMPTY_BBCODE_RE.exec(content ?? '');
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3]).toLowerCase() as FormatBbcode;
}

/** true si el mensaje no tiene nada visible fuera de los códigos `^#rrggbb`. */
export function isOnlyCaretColor(content: string): boolean {
  const text = (content ?? '').trim();
  if (!text) return false;
  return text.replace(/\^#[0-9a-fA-F]{6}\s?/g, '').trim() === '';
}

// ─── Tokenizado ──────────────────────────────────────────────────────────────

type Token =
  | { kind: 'text'; raw: string }
  | { kind: 'open'; raw: string; name: FormatBbcode; attr: string | null }
  | { kind: 'close'; raw: string; name: FormatBbcode };

const TAG_RE = /\[(\/)?(b|i|u|s|url|quote|code|color|spoiler|big|scroll|shake)(?:=([^\]\s]*))?\]/gi;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of text.matchAll(TAG_RE)) {
    const idx = m.index ?? 0;
    const [raw, slash, rawName, attr] = m;
    const name = rawName.toLowerCase() as FormatBbcode;
    // `[/b=x]` o `[b=x]` (sólo `url` y `color` llevan atributo) no son tags.
    const isTag = slash ? attr === undefined : attr === undefined || name === 'url' || name === 'color';
    if (!isTag) continue;
    if (idx > last) tokens.push({ kind: 'text', raw: text.slice(last, idx) });
    tokens.push(
      slash
        ? { kind: 'close', raw, name }
        : { kind: 'open', raw, name, attr: attr ?? null },
    );
    last = idx + raw.length;
  }
  if (last < text.length) tokens.push({ kind: 'text', raw: text.slice(last) });
  return tokens;
}

interface Pairing {
  /** Índice del cierre que corresponde a cada apertura emparejada. */
  pairs: Map<number, number>;
  /** Tokens de tag que no se emparejaron. */
  orphan: Set<number>;
  /** Tokens de tag dentro de un `[code]`: texto literal, no se tocan. */
  literal: Set<number>;
  /** Aperturas que quedaron abiertas al final, de afuera hacia adentro. */
  openAtEnd: number[];
}

/**
 * Empareja aperturas y cierres como los pinta el widget: `[code]` no
 * interpreta lo de adentro, el mismo tag anidado en sí mismo no se soporta y
 * un cierre cruzado (`[b][i]x[/b]`) deja huérfana la apertura de adentro.
 *
 * `trailingOpen`: para el corte en partes. Un `[code]` sin cerrar se
 * considera abierto (sigue en la parte siguiente) y lo que viene después es
 * texto literal.
 */
function pairTokens(tokens: Token[], trailingOpen = false): Pairing {
  const pairs = new Map<number, number>();
  const orphan = new Set<number>();
  const literal = new Set<number>();
  const stack: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === 'text') continue;

    if (tok.kind === 'open' && tok.name === 'code') {
      if (stack.some((s) => (tokens[s] as { name: string }).name === 'code')) {
        orphan.add(i);
        continue;
      }
      const close = tokens.findIndex((t, j) => j > i && t.kind === 'close' && t.name === 'code');
      if (close !== -1) {
        pairs.set(i, close);
        for (let j = i + 1; j < close; j++) if (tokens[j].kind !== 'text') literal.add(j);
        i = close;
        continue;
      }
      if (trailingOpen) {
        stack.push(i);
        for (let j = i + 1; j < tokens.length; j++) if (tokens[j].kind !== 'text') literal.add(j);
        break;
      }
      orphan.add(i);
      continue;
    }

    if (tok.kind === 'open') {
      if (stack.some((s) => (tokens[s] as { name: string }).name === tok.name)) orphan.add(i);
      else stack.push(i);
      continue;
    }

    // Cierre: busca su apertura desde el tope; lo que quede encima, huérfano.
    let k = stack.length - 1;
    while (k >= 0 && (tokens[stack[k]] as { name: string }).name !== tok.name) k--;
    if (k < 0) {
      orphan.add(i);
      continue;
    }
    for (const s of stack.splice(k + 1)) orphan.add(s);
    pairs.set(stack.pop()!, i);
  }

  if (!trailingOpen) for (const s of stack) orphan.add(s);
  return { pairs, orphan, literal, openAtEnd: trailingOpen ? stack : [] };
}

const HTTP_URL_ATTR_RE = /^https?:\/\/[^\]\s]+$/i;
const HTTP_URL_BODY_RE = /^https?:\/\/[^\s[\]]+$/i;
const HEX_COLOR_RE = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;

/** Un par que el widget no pintaría con formato (atributo inválido). */
function isInvalidPair(open: Extract<Token, { kind: 'open' }>, body: string): boolean {
  if (open.name === 'color') return !open.attr || !HEX_COLOR_RE.test(open.attr);
  if (open.name === 'url') return open.attr !== null ? !HTTP_URL_ATTR_RE.test(open.attr) : !HTTP_URL_BODY_RE.test(body);
  return false;
}

const EMPTY_BBCODE_GLOBAL_RE = new RegExp(EMPTY_BBCODE_SRC, 'gi');

/**
 * Red de seguridad de todo lo que el bot manda al chat. Devuelve el texto con:
 *   - los tags huérfanos (sin su pareja) quitados;
 *   - los tags apagados por el admin y los inválidos (`[color=red]`,
 *     `[url=javascript:…]`) desarmados, dejando el contenido;
 *   - los tags vacíos quitados, en cascada (`[b][i] [/i][/b]` → ` `).
 * Sólo toca los 12 de formato; adjuntos, `[youtube]`, etc. quedan igual.
 */
export function sanitizeBotBbcode(text: string, disabled: ReadonlySet<string> = new Set()): string {
  if (!text || (!text.includes('[') && !text.includes('||'))) return text ?? '';
  const tokens = tokenize(text);
  const { pairs, orphan } = pairTokens(tokens);

  const drop = new Set(orphan);
  for (const [open, close] of pairs) {
    const tok = tokens[open] as Extract<Token, { kind: 'open' }>;
    const body = tokens.slice(open + 1, close).map((t) => t.raw).join('');
    if (disabled.has(tok.name) || isInvalidPair(tok, body)) {
      drop.add(open);
      drop.add(close);
    }
  }

  let out = tokens
    .filter((t, i) => t.kind === 'text' || !drop.has(i))
    .map((t) => t.raw)
    .join('');

  if (disabled.has('spoiler')) out = out.replace(/\|\|([\s\S]+?)\|\|/g, '$1');

  // En cascada: quitar `[i] [/i]` puede dejar vacío al `[b]` de afuera.
  for (let guard = 0; guard < 20; guard++) {
    const next = out.replace(EMPTY_BBCODE_GLOBAL_RE, (m) => (/\s/.test(m) ? ' ' : ''));
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Para un mensaje partido en varios (`splitMessageIntoParts`): lo que quedó
 * abierto al final de una parte se cierra ahí y se reabre al principio de la
 * siguiente, así no aparece `[b]hola` en un mensaje y `mundo[/b]` literal en
 * el otro. El resultado puede quedar con tags vacíos en un borde
 * (`… [b][/b]`); de eso se encarga `sanitizeBotBbcode` al enviar.
 */
export function rebalanceBbcodeParts(parts: string[]): string[] {
  if (parts.length < 2) return parts;
  let carry: string[] = [];
  return parts.map((part) => {
    const text = carry.join('') + part;
    const tokens = tokenize(text);
    const { openAtEnd } = pairTokens(tokens, true);
    const opens = openAtEnd.map((i) => tokens[i] as Extract<Token, { kind: 'open' }>);
    carry = opens.map((t) => t.raw);
    const closes = opens
      .slice()
      .reverse()
      .map((t) => `[/${t.name}]`)
      .join('');
    return text + closes;
  });
}

/**
 * Texto legible de un mensaje con BBCode, para el modelo o la memoria:
 * quita el formato y deja el contenido.
 *
 * `spoilers`:
 *   - `'mark'` (lo que lee el modelo): `(spoiler: contenido)`. El bot puede
 *     entender la respuesta de una trivia, y el prompt le pide no revelarla.
 *   - `'hide'` (memoria, recados, log del resumen —todo lo que puede volver a
 *     salir al chat en público—): `[spoiler]`, igual que `buildReplyExcerpt`.
 */
export function bbcodeToPlain(text: string, spoilers: 'mark' | 'hide'): string {
  if (!text) return text ?? '';
  let s = text;
  s = s.replace(/\^#[0-9a-fA-F]{6}\s?/g, '');
  s = s.replace(/\[color=[^\]\s]*\]|\[\/color\]/gi, '');
  // El marcador de `'hide'` va como placeholder: si no, la limpieza de tags
  // de abajo se lo comería.
  const HIDDEN = '\u0000spoiler\u0000';
  s = s.replace(/\[spoiler\]([\s\S]*?)\[\/spoiler\]|\|\|([\s\S]+?)\|\|/gi, (_m, a?: string, b?: string) => {
    if (spoilers === 'hide') return HIDDEN;
    const body = (a ?? b ?? '').trim();
    return body ? `(spoiler: ${body})` : '';
  });
  s = s.replace(/\[url=([^\]\s]+)\]([\s\S]*?)\[\/url\]/gi, (_m, href: string, label: string) =>
    label.trim() && label.trim() !== href ? `${label} (${href})` : href,
  );
  s = s.replace(/\[\/?(?:b|i|u|s|url|quote|code|big|scroll|shake|spoiler)\]/gi, '');
  return s.split(HIDDEN).join('[spoiler]');
}
