import { createLog } from '../../common/utils/log';

const log = createLog('ResponseVerbs');

/**
 * Extractores de los verbos que el modelo escribe en su respuesta
 * (`SAVE_FACT`, `SAVE_FACT_ABOUT`, `SAVE_ERRAND`, `STICKER`, `REACT`,
 * `SAVE_INSTRUCTION`) y la barrida final de los que quedaron mal formados.
 * Lógica pura, sin estado: salió de `ChatService` para achicarlo. El orden en
 * que `ChatService.chat()` los corre importa (ver los comentarios de cada
 * uno sobre la fusión de capturas).
 */
export class ResponseVerbs {
  /**
   * Fuente única para reconocer un `SAVE_FACT(relación, objeto)` en la
   * respuesta del modelo (revisión final, Important #1). Es una fábrica, no
   * una regex compartida: al llevar la bandera `g`, el objeto `RegExp` tiene
   * estado (`lastIndex`) entre llamadas — usar la misma instancia para la
   * guarda (`test`) y para la extracción (`exec` en bucle) haría que una
   * pisara el cursor de la otra. Una instancia nueva por uso es más simple
   * que andar reseteando `lastIndex` a mano.
   *
   * Antes de esta ronda, la guarda de `chat()` era un
   * `content.includes('SAVE_FACT(')` literal — sensible a mayúsculas y sin
   * tolerancia a espacios — mientras que el regex de limpieza sí toleraba
   * ambas cosas. La brecha entre los dos criterios dejaba pasar texto crudo
   * al chat sin ingerir en varios casos reales; ahora la guarda (`hasSaveFact`
   * más abajo) corre exactamente este mismo regex.
   *
   * Reconoce, además del caso feliz `SAVE_FACT(likes, Berserk)`:
   *   - Espacio entre `SAVE_FACT` y `(`, y cualquier combinación de
   *     mayúsculas/minúsculas (case-insensitive vía `i`, más `\s*` antes del
   *     paréntesis).
   *   - Un objeto con paréntesis internos, p. ej.
   *     `SAVE_FACT(likes, Attack on Titan (2013))`. La captura del objeto es
   *     perezosa (`[\s\S]+?`) pero el `)` que la cierra sólo cuenta como
   *     cierre de la LLAMADA si lo sigue el fin de la respuesta o el
   *     comienzo de otro `SAVE_FACT(` — así el primer `)` que aparece DENTRO
   *     del objeto (el de "(2013)") no corta la captura antes de tiempo: el
   *     motor retrocede y sigue buscando hasta el `)` que de verdad cierra,
   *     dejando el objeto completo ("Attack on Titan (2013)") y sin un `)`
   *     suelto en el texto limpio. La alternativa más simple —excluir `)`
   *     del objeto con `[^)]+`— es la que tenía el bug: corta en el primer
   *     `)` sin importar si es el de cierre o uno anidado.
   *   - La llamada truncada a mitad por el tope de `maxLengthResponse`
   *     (`SAVE_FACT(likes, Berserk`, sin `)` final — el caso más probable,
   *     no el más raro, porque el prompt pide emitir el `SAVE_FACT` al final
   *     de la respuesta): si nunca aparece un `)` que satisfaga la condición
   *     de arriba, se acepta el fin de la cadena como cierre implícito.
   */
  static createSaveFactRegex(): RegExp {
    return /SAVE_FACT\s*\(\s*([a-z_]+)\s*,\s*([\s\S]+?)(?:\)(?=\s*(?:SAVE_FACT\s*\(|$))|$)/gi;
  }

  /**
   * Reconoce `SAVE_FACT_ABOUT(usuario, relación, objeto)` — hechos sobre otra
   * persona (contexto cruzado, Task 3).
   *
   * Verbo aparte y NO una tercera captura opcional dentro de
   * `createSaveFactRegex`, por una razón medible: ese regex captura la
   * relación con `([a-z_]+)`, así que con `SAVE_FACT(Sleepy Ash, likes, X)`
   * matchea "Sleepy", exige una coma, encuentra "Ash" y el regex ENTERO deja
   * de matchear — `hasSaveFact` da false y el texto crudo sale al chat sin
   * limpiar. Pasa con cualquier nombre con espacio, dígito o acento, que son
   * la mayoría. Hacer ese grupo permisivo rompería el caso de dos argumentos,
   * porque un objeto legítimo puede contener comas.
   *
   * El usuario se captura con `[^,()\n]*?`: acepta espacios, acentos y
   * dígitos (nombres reales del backend), y excluye coma, paréntesis y salto
   * de línea, que son los delimitadores de la propia llamada.
   *
   * Deliberadamente SIN cota `{1,40}` en el propio regex (ronda de revisión
   * 1): un cupo duro ahí no "rechaza" un sujeto vacío o de más de 40
   * caracteres — hace que el regex ENTERO deje de matchear en ese punto
   * (porque la coma que cierra el sujeto no aparece dentro de la ventana
   * permitida), y sin match no hay nada que reemplazar: el texto crudo sale
   * al chat. Confirmado ejecutando el regex viejo contra
   * `SAVE_FACT_ABOUT(, likes, Berserk)` (sujeto vacío) y contra un sujeto de
   * 50+ caracteres: ambos casos, cero matches, texto intacto. La cota real
   * (`FACT_ABOUT_SUBJECT_MAX_LEN`) se aplica DESPUÉS, sobre el sujeto ya
   * capturado, en `extractFactsAboutFromResponse` — así el regex siempre
   * matchea la llamada completa (garantizando la limpieza) y sólo la
   * validez del HECHO depende del largo.
   *
   * Hallazgo verificado durante el TDD de esta tarea (no estaba en el
   * brief): el lookahead de cierre no puede exigir SÓLO otro
   * `SAVE_FACT_ABOUT(` como terminador válido. Cuando la respuesta trae
   * `SAVE_FACT_ABOUT(lyna, likes, Berserk) SAVE_FACT(likes, Vagabond)` (un
   * `SAVE_FACT` de dos argumentos justo después), el primer `)` no satisface
   * ese lookahead (lo que sigue es `SAVE_FACT(`, sin `_ABOUT`) y el motor
   * retrocede hasta fusionar AMBAS llamadas en una sola captura con el
   * objeto roto ("Berserk) SAVE_FACT(likes, Vagabond") — exactamente el
   * mismo síntoma que la Task 4 ya documentó para dos `SAVE_FACT` seguidos
   * de prosa. Confirmado con un script aparte antes de tocar el regex:
   * `SAVE_FACT_ABOUT\s*\(` como único terminador deja el objeto fusionado;
   * `SAVE_FACT(?:_ABOUT)?\s*\(` (acepta tanto otro `SAVE_FACT_ABOUT(` como
   * un `SAVE_FACT(` liso) lo resuelve en los dos órdenes.
   *
   * Actualización (Task 4, recados diferidos): con un tercer verbo en juego
   * (`SAVE_ERRAND`) que TAMBIÉN se extrae ANTES del `SAVE_FACT` clásico (ver
   * `extractErrandsFromResponse`), este regex corre PRIMERO en el pipeline —
   * así que si un `SAVE_ERRAND(` aparece justo después de un
   * `SAVE_FACT_ABOUT(...)`, es ESTE regex el que tiene que reconocerlo como
   * terminador válido, no al revés. Reproducido con TDD antes de agregar la
   * alternativa: `SAVE_FACT_ABOUT(kei, likes, Berserk) SAVE_ERRAND(lyna, subí
   * el video)` fusionaba el objeto en "Berserk) SAVE_ERRAND(lyna, subí el
   * video)" hasta agregar `SAVE_ERRAND\s*\(` a la alternancia.
   */
  static createFactAboutRegex(): RegExp {
    return /SAVE_FACT_ABOUT\s*\(\s*([^,()\n]*?)\s*,\s*([a-z_]+)\s*,\s*([\s\S]+?)(?:\)(?=\s*(?:SAVE_FACT(?:_ABOUT)?\s*\(|SAVE_ERRAND\s*\(|$))|$)/gi;
  }

  /**
   * Tope real de largo del sujeto de un `SAVE_FACT_ABOUT` (revisión de
   * código, ronda 1). Ya no vive como cuantificador `{1,40}` dentro del
   * propio regex — ver el comentario de `createFactAboutRegex` sobre por
   * qué eso rechazaba matcheando NADA en vez de rechazar el hecho.
   */
  static readonly FACT_ABOUT_SUBJECT_MAX_LEN = 40;

  /**
   * Llamada truncada a mitad de camino por el tope de `maxLengthResponse` —
   * el caso más probable, no el más raro, porque el prompt pide emitir el
   * verbo al final de la respuesta (mismo motivo que ya documentó
   * `createSaveFactRegex` para `SAVE_FACT`). Con TRES argumentos en vez de
   * dos, la ventana en la que el corte cae ANTES de completar la estructura
   * mínima (sujeto + coma + relación + coma + objeto) es más grande que la
   * de `SAVE_FACT`: `createFactAboutRegex` exige las dos comas para
   * matchear, así que `SAVE_FACT_ABOUT(lyna, likes` (falta la segunda coma
   * y el objeto) o incluso `SAVE_FACT_ABOUT(lyna` (falta todo lo demás) NO
   * matchean nada — sin este paso, ese texto crudo sale tal cual al chat.
   * Confirmado ejecutando `createFactAboutRegex()` contra ambos casos antes
   * de agregar esta limpieza: cero matches, `content.replace(...)` no toca
   * nada.
   *
   * `[^)]*$` sólo mata una llamada `SAVE_FACT_ABOUT(` que llega hasta el
   * FIN de la cadena sin ningún `)` de por medio — si hubiera un `)` en
   * algún punto posterior, `createFactAboutRegex` ya la habría
   * consumido (bien formada o con objeto colgante, ver
   * `FACT_ABOUT_SUBJECT_MAX_LEN`/`hasDanglingClose`) antes de llegar acá, así
   * que esta limpieza nunca compite con esa extracción — sólo recoge lo que
   * de verdad quedó incompleto.
   */
  static createDanglingFactAboutRegex(): RegExp {
    return /SAVE_FACT_ABOUT\s*\([^)]*$/gi;
  }

  /**
   * Señal de que el objeto capturado se "comió" texto que no le
   * pertenece — un `)` de más respecto a los `(` que trae el propio objeto
   * (revisión de código, ronda 1, Important #2). Pasa cuando el lookahead de
   * cierre de `createSaveFactRegex`/`createFactAboutRegex` no encuentra
   * ningún punto de corte válido (lo que sigue no es ni otra llamada
   * reconocida ni el fin de la cadena) y el motor retrocede hasta el final
   * de la respuesta, tragándose de paso cualquier prosa suelta después del
   * `)` que en realidad cerraba la llamada.
   *
   * Reproducido antes de escribir este guard: con
   * `SAVE_FACT(likes, Vagabond) bla bla. SAVE_FACT_ABOUT(lyna, likes,
   * Berserk)`, al sacar primero el `SAVE_FACT_ABOUT` (orden que exige esta
   * misma tarea) el `SAVE_FACT` que queda detrás ("SAVE_FACT(likes,
   * Vagabond) bla bla.") ya NO tiene ningún `SAVE_FACT` textual más adelante
   * que lo salve vía `!/SAVE_FACT/i.test(object)` — el objeto capturado
   * termina siendo `"Vagabond) bla bla."`, que `ingestFact` habría escrito
   * tal cual en el grafo. Antes de esta tarea esa prosa colgante SIEMPRE
   * fusionaba con OTRA llamada `SAVE_FACT` real más adelante (el único caso
   * que existía en la suite), y esa llamada dejaba la subcadena "SAVE_FACT"
   * dentro del objeto — la guarda vieja alcanzaba por accidente. Sacar
   * `SAVE_FACT_ABOUT` antes rompe esa casualidad para esta dirección
   * puntual (verbo de terceros al final), así que hace falta una señal
   * genuina, no la ausencia casual de otro verbo.
   *
   * Un objeto con paréntesis internos balanceados ("Attack on Titan (2013)")
   * tiene la MISMA cantidad de `(` que de `)`; un objeto sano sin paréntesis
   * tiene cero de cada uno; un objeto truncado sin cierre nunca llegó a ver
   * ningún `)` (cero de cada uno también). Sólo la fusión rota deja una
   * cuenta de `)` mayor a la de `(` — es la única señal estructural
   * disponible sin necesitar saber de antemano qué había después.
   */
  static hasDanglingClose(object: string): boolean {
    const opens = (object.match(/\(/g) ?? []).length;
    const closes = (object.match(/\)/g) ?? []).length;
    return closes > opens;
  }

  /**
   * Saca `STICKER(nombre)` del texto y devuelve el primer nombre. Un solo
   * sticker por respuesta: si el modelo pone varios, se envía el primero y el
   * resto se descarta. Tolera comillas y espacios; un `STICKER(` sin cerrar
   * también se borra (sin nombre).
   */
  static extractStickerVerb(content: string): { content: string; name: string | null } {
    if (!/\bSTICKER\s*\(/i.test(content)) return { content, name: null };
    let name: string | null = null;
    const cleaned = content
      .replace(/\bSTICKER\s*\(\s*([^)]*?)\s*\)/gi, (_m, raw: string) => {
        const n = raw.replace(/^["'«“]+|["'»”]+$/g, '').trim();
        if (!name && n) name = n;
        return '';
      })
      .replace(/\bSTICKER\s*\([^)]*$/i, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    return { content: cleaned, name };
  }

  /**
   * Saca `REACT(emoji)` y devuelve el primer emoji válido. Válido = tiene al
   * menos un pictograma y nada de letras, números ni signos de BBCode/token:
   * el gateway acepta cualquier string de hasta 32 caracteres como "emoji",
   * así que sin esto el modelo podría reaccionar con una palabra.
   */
  static extractReactVerb(content: string): { content: string; emoji: string | null } {
    if (!/\bREACT\s*\(/i.test(content)) return { content, emoji: null };
    let emoji: string | null = null;
    const cleaned = content
      .replace(/\bREACT\s*\(\s*([^)]*?)\s*\)/gi, (_m, raw: string) => {
        const e = raw.replace(/^["'«“]+|["'»”]+$/g, '').trim();
        if (!emoji && ResponseVerbs.isReactionEmoji(e)) emoji = e;
        return '';
      })
      .replace(/\bREACT\s*\([^)]*$/i, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    return { content: cleaned, emoji };
  }

  static isReactionEmoji(value: string): boolean {
    if (!value || value.length > 16) return false;
    if (/[\p{L}\p{N}\s<>\[\](){}@:]/u.test(value)) return false;
    return /\p{Extended_Pictographic}/u.test(value);
  }

  /**
   * Saca todos los `SAVE_INSTRUCTION(texto)` y devuelve sus textos. El texto
   * puede traer paréntesis propios ("usá colores (rosa o celeste)"), así que
   * se recorre contando profundidad en vez de cortar en el primer `)`. Uno
   * sin cerrar se borra hasta el final y no se guarda: no se sabe dónde
   * terminaba.
   */
  static extractInstructionVerbs(content: string): { content: string; instructions: string[] } {
    const head = /\bSAVE_INSTRUCTION\s*\(/i;
    if (!head.test(content)) return { content, instructions: [] };

    const instructions: string[] = [];
    let rest = content;
    let out = '';
    let m: RegExpExecArray | null;
    while ((m = head.exec(rest)) !== null) {
      out += rest.slice(0, m.index);
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
      const raw = rest.slice(m.index + m[0].length, i - 1);
      const text = raw.trim().replace(/^["'«“]+|["'»”]+$/g, '').trim();
      if (text) instructions.push(text);
      rest = rest.slice(i);
    }
    out += rest;

    return {
      content: out.replace(/[ \t]{2,}/g, ' ').trim(),
      instructions,
    };
  }

  /**
   * Cualquier token de verbo del sistema de memoria, con sus argumentos, sin
   * exigir una forma concreta: ni cantidad de argumentos, ni comas, ni
   * siquiera el `)` de cierre. Es a propósito el regex MÁS permisivo de los
   * cuatro — corre último, cuando todo lo bien formado ya se consumió.
   *
   * `SAVE_FACT_ABOUT` va antes que `SAVE_FACT` en la alternancia: la
   * alternancia de JavaScript es de primera coincidencia, así que con el
   * orden inverso `SAVE_FACT` matchearía el prefijo y el `\s*\(` siguiente
   * fallaría contra el `_ABOUT` que queda, dejando la llamada intacta.
   */
  static createLeftoverVerbRegex(): RegExp {
    return /\b(?:SAVE|LOAD)_(?:FACT_ABOUT|FACT|ERRAND|MEMORY)\s*\([^)]*\)?/gi;
  }

  /**
   * Borra los tokens de verbo que ningún extractor reconoció. Ver el
   * comentario del punto de llamada, en `chat()`, para el hallazgo que la
   * motiva y los casos verificados.
   *
   * Si no hay nada que borrar devuelve `content` TAL CUAL, sin normalizar
   * espacios ni recortar: esta función no debe poder cambiar el texto de una
   * respuesta que no traía ningún verbo colgando, que es la abrumadora
   * mayoría.
   */
  static stripLeftoverVerbs(content: string): string {
    if (!/\b(?:SAVE|LOAD)_(?:FACT_ABOUT|FACT|ERRAND|MEMORY)\s*\(/i.test(content)) return content;
    return content
      .replace(ResponseVerbs.createLeftoverVerbRegex(), '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  /**
   * Guarda que decide si `content` amerita correr la extracción/limpieza de
   * SAVE_FACT. Deriva del mismo regex que hace la extracción (`.test()` sobre
   * una instancia fresca de `createSaveFactRegex()`) para que guarda y regex
   * nunca puedan volver a desincronizarse como pasaba con el
   * `.includes('SAVE_FACT(')` literal que reemplaza.
   */
  static hasSaveFact(content: string): boolean {
    return ResponseVerbs.createSaveFactRegex().test(content);
  }

  /**
   * Extrae los hechos sobre terceros (`SAVE_FACT_ABOUT`, Task 3) y devuelve
   * el texto sin esas llamadas.
   *
   * **Tiene que correr ANTES de `extractFactsFromResponse`.** No es una
   * preferencia de estilo: el regex de `SAVE_FACT` cierra su captura con un
   * lookahead que exige fin de respuesta u otro `SAVE_FACT(`. Con un
   * `SAVE_FACT_ABOUT(` en el medio ese lookahead no se cumple, el motor
   * retrocede y FUSIONA las dos llamadas en una sola captura con el objeto
   * roto. Sacando los `SAVE_FACT_ABOUT` primero, las dos formas nunca
   * coexisten en la misma cadena y cada regex ve exactamente lo suyo.
   *
   * Tres condiciones (además de sujeto/relación/objeto no vacíos) deciden si
   * la captura se ingesta como hecho — las tres agregadas/corregidas en la
   * ronda de revisión 1, cada una con su reproducción documentada donde vive
   * la lógica:
   *   - Largo del sujeto ≤ `FACT_ABOUT_SUBJECT_MAX_LEN` (ver el comentario de
   *     `createFactAboutRegex` sobre por qué esto no puede ser un
   *     cuantificador del propio regex).
   *   - `!/SAVE_FACT/i.test(object)` — misma señal de captura no confiable
   *     que usa `extractFactsFromResponse`.
   *   - `!hasDanglingClose(object)` — ver su comentario (Important #2).
   *
   * Después de la extracción normal, una segunda pasada de limpieza
   * (`createDanglingFactAboutRegex`) borra cualquier `SAVE_FACT_ABOUT(`
   * truncado que el regex principal no pudo reconocer como llamada completa
   * (falta alguna coma) — sin este paso, esa llamada incompleta saldría
   * cruda al chat en vez de limpiarse.
   */
  static extractFactsAboutFromResponse(content: string): {
    cleanContent: string;
    facts: Array<{ subject: string; relation: string; object: string }>;
    mergedCapture: boolean;
  } {
    const facts: Array<{ subject: string; relation: string; object: string }> = [];
    const regex = ResponseVerbs.createFactAboutRegex();
    let match: RegExpExecArray | null;
    let mergedCapture = false;

    while ((match = regex.exec(content)) !== null) {
      const subject = match[1].trim();
      const relation = match[2].trim().toLowerCase();
      const object = match[3].trim();

      if (ResponseVerbs.isMergedCapture(object)) mergedCapture = true;

      if (
        subject &&
        subject.length <= ResponseVerbs.FACT_ABOUT_SUBJECT_MAX_LEN &&
        relation &&
        object &&
        // Defensa en profundidad ampliada (Task 4): además de "SAVE_FACT"
        // (fusión con otro SAVE_FACT/SAVE_FACT_ABOUT), ahora también
        // "SAVE_ERRAND" — un tercer verbo puede fusionarse en el objeto por
        // el mismo mecanismo si el terminador de arriba fallara.
        !/SAVE_(FACT|ERRAND)/i.test(object) &&
        !ResponseVerbs.hasDanglingClose(object)
      ) {
        facts.push({ subject, relation, object });
      }

      if (match.index === regex.lastIndex) regex.lastIndex++;
    }

    let cleanContent = content.replace(ResponseVerbs.createFactAboutRegex(), '').trim();
    // Limpieza de última instancia: una llamada truncada que el regex de
    // arriba no pudo matchear como completa (ver `createDanglingFactAboutRegex`).
    cleanContent = cleanContent.replace(ResponseVerbs.createDanglingFactAboutRegex(), '').trim();
    return { cleanContent, facts, mergedCapture };
  }

  /**
   * `true` si el objeto/texto capturado se comió contenido que no le
   * pertenecía — o sea, si la captura se FUSIONÓ (re-revisión 2.3).
   *
   * Reúne las DOS señales que los extractores ya usaban por separado para
   * rechazar una captura, y les da un nombre: `hasDanglingClose` (un `)` de
   * más respecto a los `(` del propio objeto) y "hay otro verbo textual
   * adentro del objeto". Las dos significan lo mismo desde el punto de vista
   * del usuario: el regex retrocedió hasta el final de la respuesta y se
   * tragó de paso la prosa que venía después del `)` que en realidad cerraba
   * la llamada.
   *
   * Deliberadamente NO incluye las otras razones de rechazo (sujeto vacío,
   * sujeto más largo que `FACT_ABOUT_SUBJECT_MAX_LEN`, relación u objeto
   * vacíos): ahí no se comió nada, la llamada simplemente no era válida. Esa
   * distinción es justo lo que acota el acuse fijo a los casos que lo
   * necesitan.
   */
  static isMergedCapture(captured: string): boolean {
    if (!captured) return false;
    return /SAVE_(FACT|ERRAND)/i.test(captured) || ResponseVerbs.hasDanglingClose(captured);
  }

  /**
   * Reconoce `SAVE_ERRAND(usuario, texto)` (Task 4, recados diferidos). Mismo
   * criterio de captura del destinatario que `createFactAboutRegex`
   * (espacios, acentos y dígitos sí; coma, paréntesis y salto de línea no).
   *
   * Deliberadamente SIN cota `{1,40}` en el propio regex, por la MISMA razón
   * documentada en `createFactAboutRegex`: un cupo duro ahí no "rechaza" un
   * destinatario vacío o de más de 40 caracteres, hace que el regex ENTERO
   * deje de matchear en ese punto — y sin match no hay nada que reemplazar,
   * el texto crudo sale al chat. Confirmado ejecutando una versión con
   * `{1,40}` inline contra un destinatario de 50+ caracteres antes de escribir
   * esta versión: cero matches, `content.replace(...)` no toca nada. La cota
   * real (reusa `FACT_ABOUT_SUBJECT_MAX_LEN`, mismo valor y mismo motivo que
   * un nombre de persona) se aplica DESPUÉS, sobre el destinatario ya
   * capturado, en `extractErrandsFromResponse`.
   *
   * El terminador de cierre tiene que aceptar CUALQUIERA de los tres verbos
   * que el modelo puede emitir en la misma respuesta —no sólo otro
   * `SAVE_ERRAND(`—: hallazgo verificado antes de dar este regex por bueno
   * (decisión del controlador #1, mismo tipo de error que ya costó una ronda
   * en `createFactAboutRegex`). Con `SAVE_ERRAND\s*\(` como único terminador,
   * una respuesta como `SAVE_ERRAND(lyna, subí el video) SAVE_FACT(likes,
   * Vagabond)` no satisface el lookahead en el primer `)` (lo que sigue es
   * `SAVE_FACT(`, sin ser otro `SAVE_ERRAND(`), el motor retrocede y fusiona
   * ambas llamadas en una sola captura con el texto roto — igual sucede en
   * el orden inverso y con `SAVE_FACT_ABOUT(` de por medio. Las tres
   * alternativas (`SAVE_ERRAND`, `SAVE_FACT_ABOUT`, `SAVE_FACT`) cubren los
   * dos órdenes posibles con cada uno de los otros dos verbos; verificado con
   * un script aparte antes de este cambio.
   */
  static createErrandRegex(): RegExp {
    return /SAVE_ERRAND\s*\(\s*([^,()\n]*?)\s*,\s*([\s\S]+?)(?:\)(?=\s*(?:SAVE_ERRAND\s*\(|SAVE_FACT_ABOUT\s*\(|SAVE_FACT\s*\(|$))|$)/gi;
  }

  /**
   * Llamada `SAVE_ERRAND(` truncada por el tope de `maxLengthResponse` ANTES
   * de completar la estructura mínima (falta la coma, o el destinatario y
   * todo lo demás) — mismo criterio que `createDanglingFactAboutRegex`. El
   * caso más probable, no el más raro (Decisión del controlador #2): el
   * prompt pide emitir el verbo al final de la respuesta, así que el corte
   * cae justo ahí. `[^)]*$` sólo mata una llamada que llega hasta el FIN de
   * la cadena sin ningún `)` de por medio — si hubiera un `)` en algún punto
   * posterior, `createErrandRegex` ya la habría consumido antes de llegar
   * acá.
   */
  static createDanglingErrandRegex(): RegExp {
    return /SAVE_ERRAND\s*\([^)]*$/gi;
  }

  /**
   * Extrae los recados (`SAVE_ERRAND`, Task 4) y devuelve el texto sin esas
   * llamadas.
   *
   * **Tiene que correr en el mismo bloque que `extractFactsAboutFromResponse`,
   * ANTES del `SAVE_FACT` clásico** — misma razón de fusión de capturas.
   * Ver `chat()` para el orden exacto.
   *
   * Cuatro condiciones deciden si la captura se ingesta como recado, todas
   * con su contraparte ya probada en `SAVE_FACT_ABOUT` (Decisión del
   * controlador #2 — truncado y malformado no son un extra, son el caso
   * esperado):
   *   - Destinatario no vacío.
   *   - Largo del destinatario ≤ `FACT_ABOUT_SUBJECT_MAX_LEN` (reusa la misma
   *     cota que un nombre de persona; ver el comentario de
   *     `createErrandRegex` sobre por qué no puede ser un cuantificador del
   *     propio regex).
   *   - Texto no vacío.
   *   - `!/SAVE_(FACT|ERRAND)/i.test(text)` y `!hasDanglingClose(text)` —
   *     misma señal de captura fusionada que ya usan los otros dos
   *     extractores.
   *
   * Después de la extracción normal, una segunda pasada
   * (`createDanglingErrandRegex`) borra cualquier `SAVE_ERRAND(` truncado que
   * el regex principal no pudo reconocer como llamada completa — sin este
   * paso, esa llamada incompleta saldría cruda al chat en vez de limpiarse.
   */
  static extractErrandsFromResponse(content: string): {
    cleanContent: string;
    errands: Array<{ forUser: string; text: string }>;
    mergedCapture: boolean;
  } {
    const errands: Array<{ forUser: string; text: string }> = [];
    const regex = ResponseVerbs.createErrandRegex();
    let match: RegExpExecArray | null;
    let mergedCapture = false;

    while ((match = regex.exec(content)) !== null) {
      const forUser = match[1].trim();
      const text = match[2].trim();

      if (ResponseVerbs.isMergedCapture(text)) mergedCapture = true;

      if (
        forUser &&
        forUser.length <= ResponseVerbs.FACT_ABOUT_SUBJECT_MAX_LEN &&
        text &&
        !/SAVE_(FACT|ERRAND)/i.test(text) &&
        !ResponseVerbs.hasDanglingClose(text)
      ) {
        errands.push({ forUser, text });
      }

      if (match.index === regex.lastIndex) regex.lastIndex++;
    }

    let cleanContent = content.replace(ResponseVerbs.createErrandRegex(), '').trim();
    // Limpieza de última instancia: una llamada truncada que el regex de
    // arriba no pudo matchear como completa (ver `createDanglingErrandRegex`).
    cleanContent = cleanContent.replace(ResponseVerbs.createDanglingErrandRegex(), '').trim();
    return { cleanContent, errands, mergedCapture };
  }

  /**
   * Extrae los pares (relación, objeto) de todas las llamadas
   * `SAVE_FACT(relación, objeto)` presentes en la respuesta del modelo y
   * devuelve el texto limpio de esas llamadas. Reemplaza a
   * `extractMemoryFromResponse` (Task 4, fase 4b): antes se extraía una
   * frase de texto libre que había que clasificar con heurísticas
   * (`isMemoryWorthSaving`, ya eliminado); ahora la validez de cada hecho la
   * da el enum cerrado de relaciones en `GraphIngestService.ingestFact`, no
   * un conjunto de patrones acá.
   *
   * Conserva la misma protección explícita del token `{{resumen}}` que tenía
   * `extractMemoryFromResponse`: si la respuesta traía el token antes de
   * limpiar los SAVE_FACT y la limpieza (por la razón que sea) se lo llevó
   * puesto, se restaura al final en vez de perderlo — un resumen pedido no
   * puede volverse silenciosamente en un resumen que nunca se genera sólo
   * porque el modelo también emitió un hecho en la misma respuesta.
   */
  static extractFactsFromResponse(content: string): {
    cleanContent: string;
    facts: Array<{ relation: string; object: string }>;
    mergedCapture: boolean;
  } {
    const facts: Array<{ relation: string; object: string }> = [];

    const factRegex = ResponseVerbs.createSaveFactRegex();
    let match: RegExpExecArray | null;
    let mergedCapture = false;

    while ((match = factRegex.exec(content)) !== null) {
      const relation = match[1].trim().toLowerCase();
      const object = match[2].trim();

      if (ResponseVerbs.isMergedCapture(object)) mergedCapture = true;

      // Re-review (verificado empíricamente): el lookahead que decide dónde
      // cierra una llamada (ver `createSaveFactRegex`) exige que el ')' esté
      // seguido de fin de respuesta o de otro `SAVE_FACT(`. Con prosa entre
      // dos llamadas ("SAVE_FACT(likes, Berserk) Y además SAVE_FACT(likes,
      // Vagabond)"), ninguna de las dos condiciones se cumple en el primer
      // ')' — el motor retrocede y fusiona ambas llamadas en una sola
      // captura con el objeto roto ("Berserk) Y además SAVE_FACT(likes,
      // Vagabond"). Esa fusión siempre deja la subcadena "SAVE_FACT" DENTRO
      // del objeto capturado (la de la segunda llamada, que nunca se separó
      // de la primera) — es la señal inequívoca de que la captura no es
      // confiable. Mejor perder el hecho (los dos, en este caso: la fusión
      // ya se comió a ambos) que dejar un nodo `topic` con una etiqueta que
      // arrastra literal "SAVE_FACT(likes, ..." sin cerrar — sobre todo
      // porque la Fase 5 camina estas aristas para la recomendación
      // colaborativa: construir sobre datos sucios se paga después.
      //
      // Ronda de revisión 1, Important #2 (Task 3): `!hasDanglingClose`
      // cubre un caso que la señal de arriba NO detectaba — desde que
      // `SAVE_FACT_ABOUT` se extrae y se borra ANTES de que este regex
      // corra, la prosa colgante después de un `SAVE_FACT` ya no tiene
      // garantizado un `SAVE_FACT_ABOUT` textual más adelante que la
      // "salve" por accidente (dejando la subcadena "SAVE_FACT" dentro del
      // objeto fusionado). Sin este guard, `SAVE_FACT(likes, Vagabond) bla
      // bla. SAVE_FACT_ABOUT(lyna, likes, Berserk)` — con el verbo de
      // terceros ya extraído — deja el objeto fusionado en "Vagabond) bla
      // bla." (sin ningún "SAVE_FACT" textual adentro) y se ingestaba tal
      // cual. Ver el comentario de `hasDanglingClose` para la reproducción
      // completa.
      if (relation && object && !/SAVE_FACT/i.test(object) && !ResponseVerbs.hasDanglingClose(object)) {
        facts.push({ relation, object });
      }

      // El regex puede "matchear vacío" en el borde final de una llamada
      // truncada sin objeto (`SAVE_FACT(likes,` sin nada después): sin
      // avanzar el cursor a mano, `exec` repetiría la misma posición para
      // siempre. Sólo hace falta cuando el match consumió cero caracteres.
      if (match.index === factRegex.lastIndex) factRegex.lastIndex++;
    }

    // Limpiar el contenido removiendo todas las llamadas SAVE_FACT.
    // CRÍTICO: Preservar {{resumen}} si existe.
    const hasResumenToken = content.includes('{{resumen}}');
    let cleanContent = content.replace(ResponseVerbs.createSaveFactRegex(), '').trim();

    // Restaurar {{resumen}} si se perdió durante la limpieza.
    if (hasResumenToken && !cleanContent.includes('{{resumen}}')) {
      log.info('🔧 Restaurando token {{resumen}} después de limpiar SAVE_FACT...');
      cleanContent += ' {{resumen}}';
    }

    // Limpiar líneas vacías múltiples.
    cleanContent = cleanContent.replace(/\n\s*\n\s*\n/g, '\n\n');

    return { cleanContent, facts, mergedCapture };
  }
}
