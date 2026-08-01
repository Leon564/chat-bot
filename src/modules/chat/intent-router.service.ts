import { Injectable } from '@nestjs/common';
import { MusicService } from '../music/music.service';
import { ALL_BLOCKS, PromptBlock } from './prompt-builder.service';

/**
 * Decide qué bloques del prompt (ver `prompt-builder.service.ts`) se incluyen
 * para un mensaje dado. NO decide la acción que el bot va a tomar — eso lo
 * sigue haciendo el LLM emitiendo (o no) el token de cada bloque. Este router
 * sólo decide qué instrucciones quedan disponibles para que el modelo pueda
 * emitir ese token si corresponde.
 *
 * Diseño deliberadamente permisivo: un falso positivo (incluir un bloque de
 * más) cuesta unos tokens de más en el prompt, nada más. Un falso negativo
 * (omitir un bloque que hacía falta) hace que el modelo NUNCA pueda emitir el
 * token correspondiente porque la instrucción ni siquiera está en el prompt —
 * la feature desaparece en silencio, sin error visible, sólo una respuesta
 * que no hizo lo que debía. Ante la duda entre incluir y omitir, este router
 * siempre incluye.
 *
 * `ANILIST` es el caso más delicado: es el único bloque sin red de
 * seguridad. MUSIC y ONLINE tienen fast-path determinista en
 * `bot.service.ts` antes de llegar al LLM, y RESUMEN tiene inserción forzada
 * del token si el modelo lo omite (`chat.service.ts`). ANILIST no tiene nada
 * de eso: si el bloque no está en el prompt, la búsqueda en AniList
 * simplemente no puede pasar. Por eso su vocabulario es el más generoso.
 */
@Injectable()
export class IntentRouterService {
  // Saludo simple: reutiliza el espíritu del regex de `isSimpleGreeting` en
  // `chat.service.ts`, ampliado para cubrir combinaciones "<saludo> bot" /
  // "bot <saludo>" que el original no capturaba (ancla ^...$: el corte sólo
  // aplica si el mensaje ES el saludo, no si lo contiene).
  private static readonly SIMPLE_GREETING_RE =
    /^(@\w+\s+)?(hola|hi|hey|hello|como estas|que tal|buenas|saludos|bot)(\s+bot)?[?!.]*$/;

  // MUSIC: vocabulario adicional al de `MusicService.isMusicRequest` (que ya
  // cubre "reproduce", "pon música", "!music", "quiero escuchar", etc). El
  // fast-path del dispatcher en bot.service.ts ya filtra lo que este bloque
  // no atrape, así que acá conviene ser generoso.
  private static readonly MUSIC_VOCAB_RE =
    /\b(cancion|musica|tema|escuchar|ponme|toca|tocar|suena|playlist)\b/;

  // RESUMEN: mismo regex que ya usa `chat()` en chat.service.ts, reescrito
  // sin acentos porque acá trabajamos sobre el mensaje ya normalizado.
  private static readonly RESUMEN_RE =
    /(resumen|resume|que paso en el chat|de que hablaron|que se hablo|resumeme|recap)/;

  // IDENTIDAD: vocabulario sobre el bot y las reglas del chat.
  private static readonly IDENTIDAD_RE =
    /\b(creador|padre|madre|hermano|hermana|quien te|quien sos|reglas|discord|proposito|para que servis|para que sirves)\b/;

  // SAVE_MEMORY: primera persona con verbo de gusto o de estado, o una
  // afirmación sobre el usuario. Sólo se evalúa si opts.useMemory === true.
  private static readonly SAVE_MEMORY_RE =
    /\b(me gusta|me encanta|odio|prefiero|soy|tengo|vivo en|estudio|trabajo)\b/;

  // ANILIST — condición 1: vocabulario de media concreto.
  private static readonly ANILIST_MEDIA_RE =
    /manga|manhwa|manhua|anime|capitulo|cap\b|tomo|volumen|temporada|episodio|ova|light novel|novela ligera|scan|autor|mangaka/;

  // ANILIST — condición 2: vocabulario de consulta sobre una obra concreta.
  // "recomend"/"recomiend" cubren ambas familias de conjugación española
  // ("recomendar" y su forma con diptongo "recomienda/recomiendo"); "info
  // de" y "busca" se agregaron porque el corpus real las usa y no caían en
  // ninguna de las otras dos condiciones.
  private static readonly ANILIST_QUERY_RE =
    /recomend|recomiend|esta bueno|que tal esta|vale la pena|de que trata|sinopsis|leiste|viste|estoy leyendo|estoy viendo|que estas (leyendo|viendo)|info de|busca/;

  // ONLINE — guarda contra preguntas sobre UNA persona, copiada tal cual de
  // `isOnlineUsersRequest` en bot.service.ts (es la que evita el falso
  // positivo de "está el admin online?").
  private static readonly ONLINE_SINGULAR_GUARD_RE_1 =
    /\b(esta|donde\s+(esta|anda)|sabes\s+si)\s+(el|la|los|las)?\s*\w+\s+(online|en\s+linea|conectad[ao]s?|disponible)/;
  private static readonly ONLINE_SINGULAR_GUARD_RE_2 = /\b(esta|donde\s+anda)\s+@?\w+\s*\??$/;

  // ONLINE — patrones copiados tal cual de `isOnlineUsersRequest` en
  // bot.service.ts. Única adición: "mostrame" (y el artículo "los/las") en el
  // cuarto patrón, porque el corpus real lo usa y las variantes copiadas no
  // lo cubrían ("mostrar" no es substring de "mostrame").
  private static readonly ONLINE_PATTERNS: RegExp[] = [
    /\bquien(es)?\s+(esta|estan|anda|andan|hay)\s+(en\s+(la\s+)?(linea|chat|sala)|online|conectad)/,
    /\b(usuarios?|gente|personas?|miembros|raza)\s+(en\s+(la\s+)?(linea|sala|chat)|online|conectad|activ)/,
    /\bcuant[oa]s\s+(estan|hay|usuarios?|personas?|gente|online|conectad)/,
    /\b(lista|listar|listame|mostrar|mostrame|muestrame|ver|ensename)\s+(el\s+|la\s+|los\s+|las\s+)?(de\s+)?(usuarios?|gente|conectad|online|quien|personas?)/,
    /\b(who('?s|\s+is)\s+online|online\s+users|users\s+online|list\s+(of\s+)?users)/,
    /\bquien(es)?\s+(mas\s+)?(esta|estan|anda|andan)\s+(aqui|por\s+aqui|en\s+(la\s+)?(sala|chat))/,
  ];

  /**
   * `route` es `async` desde ahora aunque todavía no lo necesite: una fase
   * futura le agrega consultas al grafo de conocimiento, y cambiar la firma
   * en ese momento obligaría a tocar a todos los llamadores dos veces.
   */
  async route(message: string, opts: { useMemory: boolean }): Promise<PromptBlock[]> {
    const normalized = this.normalize(message);
    const included = new Set<PromptBlock>(['PERSONA', 'TEMPORAL']);

    if (IntentRouterService.SIMPLE_GREETING_RE.test(normalized)) {
      return ALL_BLOCKS.filter((block) => included.has(block));
    }

    if (
      MusicService.isMusicRequest(message) ||
      IntentRouterService.MUSIC_VOCAB_RE.test(normalized)
    ) {
      included.add('MUSIC');
    }

    if (this.isAnilistRequest(normalized)) {
      included.add('ANILIST');
    }

    if (IntentRouterService.IDENTIDAD_RE.test(normalized)) {
      included.add('IDENTIDAD');
    }

    if (IntentRouterService.RESUMEN_RE.test(normalized)) {
      included.add('RESUMEN');
    }

    if (this.isOnlineUsersRequest(normalized)) {
      included.add('ONLINE');
    }

    if (opts.useMemory && IntentRouterService.SAVE_MEMORY_RE.test(normalized)) {
      included.add('SAVE_MEMORY');
    }

    return ALL_BLOCKS.filter((block) => included.has(block));
  }

  /**
   * Normaliza una sola vez: minúsculas, sin acentos, espacios colapsados.
   * Usa la forma escapada del rango de diacríticos (\u0300-\u036f) y NO
   * los caracteres combinantes crudos — hay precedente en este repo de que
   * un editor los normaliza a NFC y el regex queda inerte en silencio.
   */
  private normalize(message: string): string {
    if (!message || typeof message !== 'string') return '';
    return message
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isAnilistRequest(normalized: string): boolean {
    if (IntentRouterService.ANILIST_MEDIA_RE.test(normalized)) return true;
    if (IntentRouterService.ANILIST_QUERY_RE.test(normalized)) return true;
    // Punto de extensión: una fase futura agrega acá señales basadas en el
    // grafo de conocimiento (por ejemplo, títulos ya mencionados en la
    // conversación reciente) como tercera condición.
    return false;
  }

  private isOnlineUsersRequest(normalized: string): boolean {
    if (!normalized) return false;

    const singularUserQuestion =
      IntentRouterService.ONLINE_SINGULAR_GUARD_RE_1.test(normalized) ||
      IntentRouterService.ONLINE_SINGULAR_GUARD_RE_2.test(normalized);
    if (singularUserQuestion) return false;

    return IntentRouterService.ONLINE_PATTERNS.some((re) => re.test(normalized));
  }
}
