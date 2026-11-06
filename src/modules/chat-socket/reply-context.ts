/**
 * Contexto de un reply (Discord-style) para el modelo: cuando alguien le
 * habla al bot respondiendo a otro mensaje, el texto escrito suele no tener
 * sentido solo ("bot qué opinás de esto?"). El bot necesita el mensaje padre.
 */
export interface ReplyContext {
  /** Autor del mensaje al que se responde. */
  author: string;
  /** Texto del mensaje padre, ya normalizado (sin color, BBCode ni `<@...>`). */
  content: string;
}

/** Tope del texto padre que se le pasa al modelo: suficiente para entender de qué se habla sin inflar el prompt. */
export const MAX_REPLY_CONTEXT_CHARS = 600;

/**
 * Normaliza el cuerpo de un mensaje del chat a texto legible. Misma idea que
 * `buildReplyExcerpt` del backend (`backend/src/chat/content-preview.ts`),
 * pero sin el corte a 140: acá el texto completo es justamente el punto.
 */
export function normalizeMessageText(content: string | undefined, type?: string): string {
  if (type === 'sticker') return '[sticker]';
  let text = content ?? '';
  text = text.replace(/\^#[0-9a-fA-F]{6}\s?/g, '');
  text = text.replace(/\[color=#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\]|\[\/color\]/gi, '');
  text = text.replace(/\[(img|image|audio|video|youtube|embed)(\s[^\]]*)?\][\s\S]*?\[\/\1\]/gi, '[media]');
  text = text.replace(/\[wordle(\s[^\]]*)?\][\s\S]*?\[\/wordle\]/gi, '[wordle]');
  text = text.replace(/<@([^>]+)>/g, '@$1');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_REPLY_CONTEXT_CHARS) text = `${text.slice(0, MAX_REPLY_CONTEXT_CHARS).trimEnd()}…`;
  return text;
}
