import { Injectable, Optional } from '@nestjs/common';
import { GraphService } from '../graph/graph.service';
import { createLog } from '../../common/utils/log';

const log = createLog('MusicIntentService');

/** Puntaje mínimo para tratar el mensaje como pedido de canción. */
export const MUSIC_INTENT_THRESHOLD = 2;

/**
 * Verbos al PRINCIPIO del mensaje y su puntaje base. Los inequívocos arrancan
 * en el umbral; `pon`/`toca` son ambiguos en español ("pon atención", "toca
 * esperar") y necesitan una señal más (el grafo) para pasar.
 */
// `(?=\s|$)` y no `\b`: en JS `\b` sólo conoce letras ASCII, así que después
// de "reproducí" o "poné" no veía el fin de palabra.
const VERBS: Array<{ re: RegExp; base: number }> = [
  { re: /^(?:reproduce|reproduc[ií]|play)(?=\s|$)/i, base: 2 },
  { re: /^(?:ponme|pon[eé]me|ponmela|pon[eé]mela)(?=\s|$)/i, base: 2 },
  { re: /^(?:pon|pon[eé]|toca|toc[aá])(?=\s|$)/i, base: 1 },
];

/** Primera palabra de lo pedido que delata charla, no una canción. */
const NOT_A_SONG_START = new Set([
  'eso', 'esto', 'esa', 'ese', 'esta', 'este', 'aquello', 'lo', 'le', 'les', 'te', 'me', 'se',
  'atención', 'atencion', 'cuidado', 'ojo', 'un', 'una', 'unos', 'unas', 'ejemplo', 'en', 'a', 'al',
  'de', 'que', 'mas', 'más', 'esperar', 'orden', 'pausa', 'stop', 'nada', 'algo', 'todo',
  'tu', 'mi', 'su', 'sus', 'mis', 'tus', 'el', 'los', 'las',
]);

/** Palabras que apuntan a otra cosa que una canción ("reproduce el video de ayer"). */
const OTHER_MEDIA = /\b(?:v[ií]deos?|audios?|pantalla|stream|directo|clip)\b/i;

/** Lo que se descarta del principio de lo pedido: "la canción", "el tema", "la de". */
const QUERY_PREFIX = /^(?:(?:la|una)\s+(?:canci[oó]n|rola|song)\s+(?:de\s+)?|el\s+tema\s+(?:de\s+)?|la\s+de\s+|algo\s+de\s+)/i;

export interface MusicIntent {
  isRequest: boolean;
  score: number;
  /** Lo que se buscaría (sin el verbo ni "la canción"). */
  query: string;
  reasons: string[];
}

/**
 * Decide, sin llamar al modelo, si un mensaje que NO le habla al bot es un
 * pedido de canción ("reproduce ita song de yorushika").
 *
 * Antes cualquier mensaje con "reproduce" o "tema de" en cualquier lugar
 * disparaba una descarga; después se exigió nombrar al bot. Esto recupera el
 * caso cómodo sin volver a los falsos positivos:
 *  - sólo se evalúa si el mensaje EMPIEZA con un verbo de reproducir (así
 *    "quién reproduce el video" o "el tema de hoy" ni califican);
 *  - el grafo suma si lo pedido —o una de sus partes, "canción de artista"—
 *    es una canción o un artista que ya se pidió antes;
 *  - preguntas, pronombres/demostrativos, "video" y mensajes largos restan.
 */
@Injectable()
export class MusicIntentService {
  constructor(@Optional() private readonly graph?: GraphService) {}

  /** Parte sincrónica: verbo, lo pedido y las señales del texto. */
  static parse(content: string): { base: number; query: string; textScore: number; reasons: string[] } | null {
    const text = (content ?? '').trim();
    const verb = VERBS.find((v) => v.re.test(text));
    if (!verb) return null;

    const reasons: string[] = [`verbo +${verb.base}`];
    let textScore = 0;

    const afterVerb = text.replace(verb.re, '').trim();
    const query = afterVerb
      .replace(QUERY_PREFIX, '')
      .replace(/^["'«“]+|["'»”.!]+$/g, '')
      .trim();
    if (query.length < 2 || query.length > 80) return null;

    if (/[?¿]/.test(text)) {
      textScore -= 3;
      reasons.push('pregunta -3');
    }
    const first = query.split(/\s+/)[0].toLowerCase();
    if (NOT_A_SONG_START.has(first)) {
      textScore -= 3;
      reasons.push(`empieza con "${first}" -3`);
    }
    if (OTHER_MEDIA.test(query)) {
      textScore -= 2;
      reasons.push('otro medio -2');
    }
    if (query.split(/\s+/).length > 8) {
      textScore -= 2;
      reasons.push('largo -2');
    }

    return { base: verb.base, query, textScore, reasons };
  }

  /** Partes que se buscan en el grafo: todo, y "canción" / "artista" si hay separador. */
  static graphNeedles(query: string): string[] {
    const parts = query.split(/\s+(?:de|by|-|–|—)\s+/i).map((p) => p.trim()).filter((p) => p.length >= 2);
    return [...new Set([query, ...parts])].slice(0, 4);
  }

  async classify(content: string): Promise<MusicIntent | null> {
    const parsed = MusicIntentService.parse(content);
    if (!parsed) return null;

    let score = parsed.base + parsed.textScore;
    const reasons = [...parsed.reasons];

    // El grafo sólo puede sumar, y sólo vale la pena consultarlo si con esa
    // suma se puede llegar al umbral.
    if (this.graph && score < MUSIC_INTENT_THRESHOLD && score + 2 >= MUSIC_INTENT_THRESHOLD) {
      try {
        for (const needle of MusicIntentService.graphNeedles(parsed.query)) {
          const node = await this.graph.resolveByAlias(needle, ['track', 'artist']);
          if (node) {
            score += 2;
            reasons.push(`grafo: ${node.type} "${node.label}" +2`);
            break;
          }
        }
      } catch (err) {
        log.warn(`No se pudo consultar el grafo: ${(err as Error)?.message}`);
      }
    }

    const intent = { isRequest: score >= MUSIC_INTENT_THRESHOLD, score, query: parsed.query, reasons };
    log.debug(`"${content}" → ${intent.isRequest ? 'pedido' : 'no'} (${score}: ${reasons.join(', ')})`);
    return intent;
  }
}
