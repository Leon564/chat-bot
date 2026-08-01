import { Injectable } from '@nestjs/common';
import { MusicService } from '../music/music.service';
import { ALL_BLOCKS, PromptBlock } from './prompt-builder.service';
import { GraphService } from '../graph/graph.service';

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

  // ANILIST por grafo — condición 3, ver `isAnilistByGraph`.
  //
  // N-gramas de 1 a 5 palabras. El mínimo era 2 mientras la consulta era un
  // `await` por candidato (un unigrama disparaba demasiado ruido a un costo
  // por-consulta que no valía la pena); con `GraphService.resolveAnyAlias`
  // todos los candidatos viajan en un único `$in`, así que agregar
  // unigramas no agrega consultas — sólo términos a la misma consulta. Y
  // hacía falta: la condición 1 existe para reconocer un título cuando el
  // mensaje NO trae vocabulario de media, y en un bot de anime/manga la
  // mayoría de los títulos son una sola palabra (Berserk, Naruto, Frieren,
  // Monster, Bleach). Sin unigramas, "alguien sigue berserk?" no tenía
  // ninguna vía hacia ANILIST.
  //
  // El unigrama sí se filtra (ver `isPlausibleTitleWord`) para no llenar la
  // consulta de ruido: palabras de menos de 3 caracteres y una lista corta
  // de vacías en español/inglés quedan afuera. Los n-gramas de 2+ palabras
  // NO se filtran — ahí la combinación ya es señal suficiente.
  //
  // Se generan de mayor a menor tamaño (los títulos completos son más
  // específicos que sus subcadenas) y se acota a `GRAPH_NGRAM_CANDIDATE_CAP`
  // candidatos: no porque dispare más consultas (van todos juntos en un
  // único `$in`), sino para no mandar un array desmedido a Mongo cuando el
  // mensaje es muy largo.
  private static readonly GRAPH_NGRAM_MAX_SIZE = 5;
  private static readonly GRAPH_NGRAM_MIN_SIZE = 1;
  private static readonly GRAPH_NGRAM_CANDIDATE_CAP = 60;
  private static readonly GRAPH_UNIGRAM_MIN_LENGTH = 3;

  // Palabras vacías frecuentes en español e inglés (artículos, preposiciones,
  // pronombres, conjunciones, verbos comunes) — sólo filtran UNIGRAMAS. No
  // pretende ser exhaustiva, sólo cortar el ruido más obvio.
  private static readonly GRAPH_STOPWORDS = new Set([
    // español
    'que', 'los', 'las', 'del', 'con', 'por', 'para', 'una', 'uno', 'este',
    'esta', 'esto', 'eso', 'esa', 'ese', 'esos', 'esas', 'estos', 'estas',
    'como', 'pero', 'mas', 'muy', 'todo', 'toda', 'todos', 'todas', 'unos',
    'unas', 'algo', 'nada', 'aqui', 'alli', 'ahi', 'cada', 'otra', 'otro',
    'sobre', 'entre', 'desde', 'hasta', 'donde', 'cuando', 'porque', 'ahora',
    'antes', 'siempre', 'nunca', 'tambien',
    // inglés
    'the', 'and', 'for', 'you', 'this', 'that', 'not', 'are', 'was', 'were',
    'have', 'has', 'his', 'her', 'its', 'our', 'their', 'from', 'with',
    'about', 'then', 'than', 'will', 'would', 'can', 'could', 'just',
    'your', 'they', 'them', 'what', 'when', 'where', 'why', 'how',
  ]);

  // "En sus últimos 2 turnos" (spec original) no es algo que el grafo pueda
  // responder: las aristas guardan `lastSeenAt`, no posición conversacional.
  // Se aproxima con una ventana de 10 minutos — ver nota en el reporte de
  // la Task 3.
  private static readonly RECENT_THREAD_WINDOW_MS = 10 * 60 * 1000;

  constructor(private readonly graphService: GraphService) {}

  /**
   * `route` es `async` desde la Task 2: la Task 3 le agrega dos condiciones
   * que consultan el grafo de conocimiento (alias de obras ya conocidas +
   * hilo reciente del usuario).
   */
  async route(
    message: string,
    opts: { useMemory: boolean; username?: string },
  ): Promise<PromptBlock[]> {
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

    if (
      this.isAnilistRequest(normalized) ||
      (await this.isAnilistByGraph(normalized, opts.username))
    ) {
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
    return false;
  }

  /**
   * ANILIST — condición 3: señales basadas en el grafo de conocimiento.
   * Todo lo que toca Mongo acá está deliberadamente en un único try/catch:
   * un grafo caído degrada a las heurísticas de vocabulario de
   * `isAnilistRequest`, nunca deja al router sin poder decidir.
   */
  private async isAnilistByGraph(normalized: string, username?: string): Promise<boolean> {
    try {
      if (await this.matchesKnownWorkAlias(normalized)) return true;
      if (username && (await this.hasRecentWorkThread(username))) return true;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Consulta contra el grafo, en una sola llamada, todos los n-gramas
   * candidatos del mensaje (`resolveAnyAlias` arma un único `$in` — ver
   * `GraphService`). Antes esto era un loop con un `await` por candidato,
   * hasta 40 round-trips secuenciales a Mongo en el peor caso; ahora es
   * siempre 1 consulta, tenga el mensaje 2 candidatos o 40.
   */
  private async matchesKnownWorkAlias(normalized: string): Promise<boolean> {
    const candidates = this.extractAliasCandidates(normalized);
    if (candidates.length === 0) return false;
    const node = await this.graphService.resolveAnyAlias(candidates, ['work', 'genre']);
    return node !== null;
  }

  /**
   * Genera los n-gramas candidatos de 1 a 5 palabras, de mayor a menor
   * tamaño (un título completo es más específico que su subcadena, así que
   * conviene intentarlo primero — importa para el desempate por peso en
   * `resolveAnyAlias` sólo en el margen, pero no hay razón para invertirlo).
   * Los unigramas se filtran con `isPlausibleTitleWord`; los n-gramas de 2+
   * palabras se incluyen todos, sin filtrar.
   *
   * La puntuación se recorta SÓLO al principio y al final de cada palabra,
   * nunca en el medio: así "tower of god?" sigue generando el candidato
   * "tower of god" (el signo pegado a la última palabra no debe impedir el
   * match), pero un alias con puntuación interna legítima como "jojo's
   * bizarre adventure" o "re:zero" no se destruye — `GraphService.normalizeKey`
   * tampoco le toca la puntuación interna, así que candidato y alias
   * guardado tienen que coincidir carácter a carácter.
   */
  private extractAliasCandidates(normalized: string): string[] {
    const words = normalized
      .split(/\s+/)
      .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
      .filter(Boolean);

    const candidates: string[] = [];
    for (
      let size = IntentRouterService.GRAPH_NGRAM_MAX_SIZE;
      size >= IntentRouterService.GRAPH_NGRAM_MIN_SIZE;
      size--
    ) {
      for (let i = 0; i + size <= words.length; i++) {
        if (size === 1 && !this.isPlausibleTitleWord(words[i])) continue;
        candidates.push(words.slice(i, i + size).join(' '));
        if (candidates.length >= IntentRouterService.GRAPH_NGRAM_CANDIDATE_CAP) {
          return candidates;
        }
      }
    }
    return candidates;
  }

  /**
   * Filtro de unigramas: descarta palabras de menos de 3 caracteres y una
   * lista corta de vacías en español/inglés (ver `GRAPH_STOPWORDS`). Sólo se
   * aplica a candidatos de una palabra — un n-grama de 2+ palabras ya es
   * señal suficiente por la combinación, aunque una de ellas fuera vacía.
   */
  private isPlausibleTitleWord(word: string): boolean {
    return (
      word.length >= IntentRouterService.GRAPH_UNIGRAM_MIN_LENGTH &&
      !IntentRouterService.GRAPH_STOPWORDS.has(word)
    );
  }

  /**
   * "El usuario tocó un nodo `work` en sus últimos 2 turnos" (spec original)
   * no es algo que el grafo pueda responder tal cual: las aristas guardan
   * `lastSeenAt` (un instante), no una posición conversacional. Se aproxima
   * con una ventana de 10 minutos — ver desviación anotada en el reporte.
   */
  private async hasRecentWorkThread(username: string): Promise<boolean> {
    const userNode = await this.graphService.findNode('user', username);
    if (!userNode) return false;

    const [topEdge] = await this.graphService.topEdges(userNode._id, ['asked_about'], 1);
    if (!topEdge || !topEdge.lastSeenAt) return false;

    const ageMs = Date.now() - new Date(topEdge.lastSeenAt).getTime();
    return ageMs >= 0 && ageMs <= IntentRouterService.RECENT_THREAD_WINDOW_MS;
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
