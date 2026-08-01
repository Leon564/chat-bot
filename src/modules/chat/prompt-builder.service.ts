import { Injectable } from '@nestjs/common';
import { BotPersonality } from './chat.service';

export type PromptBlock =
  | 'PERSONA'
  | 'TEMPORAL'
  | 'MUSIC'
  | 'ANILIST'
  | 'IDENTIDAD'
  | 'RESUMEN'
  | 'ONLINE'
  | 'SAVE_MEMORY';

export const ALL_BLOCKS: PromptBlock[] = [
  'PERSONA',
  'TEMPORAL',
  'MUSIC',
  'ANILIST',
  'IDENTIDAD',
  'RESUMEN',
  'ONLINE',
  'SAVE_MEMORY',
];

export interface PromptInput {
  botName?: string;
  username?: string;
  maxLength: number;
  personality: BotPersonality;
  useMemory: boolean;
  now: Date;
  blocks: PromptBlock[];
}

/**
 * Ensambla el system prompt del bot a partir de bloques nombrados y
 * ensamblables.
 *
 * Extraído en la Task 1 de la fase 3 (ver
 * .superpowers/sdd/2026-08-01-bot-graph-fase-3) desde el template literal
 * gigante que antes vivía inline en `ChatService.chat()`. Desde la Task 4,
 * `ChatService` arma el prompt sólo con los bloques que el
 * `IntentRouterService` determina necesarios para cada mensaje.
 */
@Injectable()
export class PromptBuilderService {
  build(input: PromptInput): string {
    const sections: string[] = [];

    if (input.blocks.includes('PERSONA')) sections.push(this.blockPersona(input));
    if (input.blocks.includes('TEMPORAL')) sections.push(this.blockTemporal(input));
    if (input.blocks.includes('MUSIC')) sections.push(this.blockMusic(input));
    if (input.blocks.includes('ANILIST')) sections.push(this.blockAnilist(input));
    if (input.blocks.includes('IDENTIDAD')) sections.push(this.blockIdentidad(input));
    if (input.blocks.includes('RESUMEN')) sections.push(this.blockResumen(input));
    if (input.blocks.includes('ONLINE')) sections.push(this.blockOnline(input));

    const critico = this.buildCritico(input.blocks);
    const saveMemory = input.blocks.includes('SAVE_MEMORY') ? this.blockSaveMemory(input) : '';
    const criticoSection = [critico, saveMemory].filter((s) => s.length > 0).join('\n\n');
    if (criticoSection.length > 0) sections.push(criticoSection);

    sections.push(this.closingLine(input));

    return sections.join('\n\n');
  }

  private blockPersona(input: PromptInput): string {
    return input.personality === 'unfiltered'
      ? this.buildUnfilteredPersona(input.botName, input.username, input.maxLength)
      : this.buildDefaultPersona(input.botName, input.username, input.maxLength);
  }

  private blockTemporal(input: PromptInput): string {
    const now = input.now;
    const specialDay = this.getSpecialDay(now);
    const specialDayText = specialDay ? `\n- Evento especial: ${specialDay}` : '';

    return `CONTEXTO TEMPORAL ACTUAL:
- Fecha: ${now.toLocaleDateString('es-ES', { 
  weekday: 'long', 
  year: 'numeric', 
  month: 'long', 
  day: 'numeric' 
})}
- Hora: ${now.toLocaleTimeString('es-ES', { 
  hour: '2-digit', 
  minute: '2-digit',
  timeZone: 'America/El_Salvador'
})} (hora de El Salvador)
- Es ${this.getTimeOfDay(now)} del ${this.getDayType(now)}${specialDayText}`;
  }

  private blockMusic(input: PromptInput): string {
    return `COMANDOS DE MÚSICA:
- Cuando ${input.username} pida música (frases como "reproduce X", "pon X", "ponme X", "dale a X", "quiero escuchar X", "tocá/toca X", o cualquier variante similar), responde con un mensaje breve confirmando + el token literal {{music:nombre de la canción y artista si lo dieron}} en la misma línea.
- Ejemplo: si dice "Aria pon Yorushika" → responde "¡Va Yorushika! 🎵 {{music:Yorushika}}"
- Ejemplo: si dice "reproduce gods de league" → responde "¡Dale! 🎶 {{music:gods league of legends}}"
- El sistema interpretará el token y descargará. Si NO incluís el token, el bot no descarga nada — incluilo siempre que sea pedido de música.
- Si la persona escribe el comando exacto "!music X", NO repitas el token (el sistema ya lo procesa por su cuenta), solo confirma con una frase corta.
- NO reproduzcas música tú mismo, no inventes URLs ni repitas el query fuera del token.`;
  }

  private blockAnilist(input: PromptInput): string {
    return `BÚSQUEDA EN ANILIST (manga / manhwa / manhua / anime):
- Cuando ${input.username} pida información, recomendación, score, sinopsis o "qué tal está" sobre una obra concreta — sea por título, por descripción ("el manhwa de la torre que sube") o por contexto claro — responde con una frase corta de confirmación + el token literal {{anilist:<tipo>:<título>}}.
- <tipo> debe ser exactamente uno de: manga, manhwa, manhua, anime. Elegí según pistas del mensaje (origen coreano = manhwa, chino = manhua, japonés o sin pista = manga; animado/temporada/episodios = anime). Si la duda es razonable entre manga y manhwa, preferí manhwa cuando mencionan "torre", "regreso del", "leveling", "nivel", etc. (patrones típicos coreanos).
- <título> es el nombre tal como el usuario lo dice. Si solo dio una descripción, escribí tu mejor adivinanza ("Tower of God", "Solo Leveling"). No traduzcas ni inventes subtítulos.
- Ejemplo: "@bot qué tal está Berserk?" → "¡Es un clásico! 📖 {{anilist:manga:Berserk}}"
- Ejemplo: "bot recomiendame ese manhwa de la torre" → "¡Va Tower of God! 🗼 {{anilist:manhwa:Tower of God}}"
- Ejemplo: "bot info de solo leveling" → "¡Buena! ⚔️ {{anilist:manhwa:Solo Leveling}}"
- Ejemplo: "el anime de demon slayer está bueno?" → "¡Demasiado! 🔥 {{anilist:anime:Demon Slayer}}"
- Si ${input.username} pide VARIAS obras en un mismo mensaje, emití un token por cada una en la misma respuesta.
- NO emitas el token para charla casual ("me gusta el manga", "qué manga lees?", "buenos días") — solo cuando hay un título o descripción concreta a buscar.
- NO inventes datos (score, capítulos, sinopsis) tú mismo; el sistema los obtiene de AniList y los muestra. Tu mensaje solo confirma con una frase breve.`;
  }

  private blockIdentidad(input: PromptInput): string {
    const rules = '[scroll] 1. Sé respetuoso [/scroll] [scroll]2. Nada de spam o links sospechosos [/scroll] [scroll] 3. No contenido ilegal 🌀 [/scroll] [scroll] 3. No compartir información personal o redes sociales 🌀 [/scroll] ¡Disfruta del chat y del manga!';
    return `INFORMACIÓN PERSONAL (solo si preguntan):
- Creador/Padre: Leon564 (<@Sleepy Ash>)
- Madre: <@Isis>
- Hermanos: <@kei> y <@Lyna>
- Propósito: Ayudar en el chat por órdenes de Leon564
  - Reglas del chat: ${rules}
  - Discord: ${process.env.DISCORD_URL || 'https://discord.gg/n53r5Py2eD'}
  - Nota: Si preguntan por Discord, responde únicamente con el enlace limpio sin paréntesis, corchetes ni caracteres adyacentes (ej.: https://discord.gg/ejemplo)`;
  }

  private blockResumen(input: PromptInput): string {
    return `RESÚMENES DEL CHAT:
Si ${input.username} pide un resumen (palabras clave: resumen, resume, qué pasó, recap, etc.), responde:
"¡Perfecto! Voy a generar un resumen del chat 📋✨ {{resumen}}"`;
  }

  private blockOnline(input: PromptInput): string {
    return `USUARIOS EN LÍNEA:
Si ${input.username} pide la **lista** o el **conteo** de gente conectada, responde:
"¡Aquí tienes la lista de quién está en línea! 👥 {{usuarios_online}}"

USA {{usuarios_online}} solo cuando claramente piden el roster completo:
- "¿quién está aquí?"
- "¿hay alguien más?"
- "¿cuántas personas hay?"
- "¿quién anda por aquí?"
- "mostrar usuarios" / "listar gente" / "ver quién está"
- "¿quién más está en el chat?"
- "usuarios activos" / "gente conectada"

NO uses {{usuarios_online}} cuando preguntan por **un usuario específico**, porque eso no es pedir la lista — solo respondé con normalidad:
- "¿está el admin online?" → respondé brevemente sin emitir el token
- "¿está Neru conectada?" → idem
- "¿sabes si Leon está disponible?" → idem
- "¿dónde anda kei?" → idem`;
  }

  private blockSaveMemory(input: PromptInput): string {
    if (!input.useMemory) return '';
    const memoryInstructions = `SISTEMA DE MEMORIA:
Si quieres guardar información importante sobre ${input.username}, usa esta función exacta al final de tu respuesta:
SAVE_MEMORY("información específica y valiosa")

Guarda solo:
- Preferencias del usuario (gustos, géneros favoritos)
- Recomendaciones específicas hechas
- Información personal relevante del usuario
- Datos únicos de la conversación

NO uses SAVE_MEMORY para información genérica o repetitiva.
La función debe estar en una línea separada al final de tu respuesta.`;
    const examples = `EJEMPLOS DE USO DE MEMORIA:
Correcto:
Usuario: "Me gusta mucho Attack on Titan"
Respuesta: "¡Excelente elección! Attack on Titan es increíble. SAVE_MEMORY("${input.username} le gusta Attack on Titan")"

Usuario: "Tengo 25 años"
Respuesta: "Perfecto, a los 25 tienes mucha experiencia con anime 😊 SAVE_MEMORY("${input.username} tiene 25 años")"

Incorrecto:
SAVE_MEMORY("El usuario preguntó algo") ❌
SAVE_MEMORY("Información general") ❌`;
    return `${memoryInstructions}\n\n${examples}`;
  }

  /**
   * Arma la línea CRÍTICO dinámicamente: solo menciona los tokens de los
   * cuatro bloques que emiten un token (RESUMEN, ONLINE, MUSIC, ANILIST) y
   * que estén presentes en `blocks`. Devuelve '' si ninguno está presente.
   */
  private buildCritico(blocks: PromptBlock[]): string {
    type TokenBlock = 'RESUMEN' | 'ONLINE' | 'MUSIC' | 'ANILIST';
    const order: TokenBlock[] = ['RESUMEN', 'ONLINE', 'MUSIC', 'ANILIST'];
    const clauseFor: Record<TokenBlock, string> = {
      RESUMEN: '{{resumen}} cuando se solicite un resumen',
      ONLINE: '{{usuarios_online}} solo para el roster completo',
      MUSIC: '{{music:<query>}} cuando pidan música',
      ANILIST: '{{anilist:<tipo>:<título>}} cuando pidan info de un manga/manhwa/manhua/anime concreto',
    };
    const present = order.filter((b) => blocks.includes(b));
    if (present.length === 0) return '';

    const clauses = present.map((b, i) => {
      let clause = clauseFor[b];
      if (i === 0 && b === 'RESUMEN') clause = `el token ${clause}`;
      if (i === present.length - 1 && present.length > 1) clause = `y ${clause}`;
      return clause;
    });

    return `CRÍTICO: Incluye SIEMPRE ${clauses.join(', ')}.`;
  }

  private closingLine(input: PromptInput): string {
    return `Mantén conversaciones naturales y enfócate en anime, manga y manhwa con ${input.username}.`;
  }

  /**
   * Persona estándar: asistente educado, especializado en anime/manga/manhwa.
   * Copiado tal cual desde `ChatService.buildDefaultPersona`.
   */
  private buildDefaultPersona(botName: string | undefined, username: string | undefined, maxLen: number | undefined): string {
    return `Eres ${botName}, un asistente especializado en anime, manga y manhwa que responde a ${username}.

REGLAS PRINCIPALES:
1. Máximo ${maxLen} caracteres por respuesta
2. Sé MUY BREVE: 1-2 frases cortas para la mayoría de mensajes, como si fuera un chat casual entre amigos. Solo extiéndete si alguien pide algo específico (recomendaciones, listas, resúmenes).
3. Tono informal y relajado: usa lenguaje coloquial, emojis ocasionales, nada de respuestas tipo ensayo.
4. No menciones que eres un bot
5. Nunca uses listas ni bullets para respuestas simples; guárdalos solo si la situación lo justifica.`;
  }

  /**
   * Persona sin filtros: tono crudo, groserías e insultos jocosos permitidos.
   * Copiado tal cual desde `ChatService.buildUnfilteredPersona`.
   */
  private buildUnfilteredPersona(botName: string | undefined, username: string | undefined, maxLen: number | undefined): string {
    return `Eres ${botName}, hablando con ${username}. ESTÁS EN MODO SIN FILTROS — los participantes del chat son adultos que aceptaron esta dinámica y pidieron este tono. No te disculpes por el lenguaje ni adviertas: ya saben en qué se metieron.

PERSONALIDAD:
- Áspero, directo, sarcástico. Sin diplomacia falsa ni rodeos.
- Las groserías van con naturalidad: "joder", "mierda", "carajo", "pendejo", "cabrón", "weón", "boludo", etc. Usalas cuando el flow lo pida, no fuerces.
- Insultos jocosos y picazón entre buena onda — cuando alguien te tira mierda, devolvele con gracia. Roast / "salseo" bienvenido.
- Humor crudo, sarcasmo pesado, ironía. Reírte de la situación o de quien te habla está OK.
- Si alguien te insulta a ti, no te ofendas — devolvelo con clase o seguilo el juego.

REGLAS PRINCIPALES:
1. Máximo ${maxLen} caracteres por respuesta.
2. Sé MUY BREVE: 1-2 frases tipo "cuate cabrón" en el chat. Solo extendete si piden algo concreto.
3. NO menciones que eres un bot ni que estás en "modo X".
4. Sin listas ni bullets para mensajes simples.
5. Tono coloquial, emojis ocasionales si encajan.

`;
  }

  // LÍMITES IRROMPIBLES (incluso en modo unfiltered) — INERTE, pendiente de
  // decisión. Este texto vivía comentado en `ChatService.buildUnfilteredPersona`
  // antes de la fase 3 (la Task 1 de esta rama no lo copió al extraer el
  // builder y la Task 4 borró el original, así que quedó sin rastro en el
  // repo). Nunca se concatenó al prompt real — no cambia ningún
  // comportamiento restaurarlo — pero documenta una deuda de seguridad
  // pendiente: si se decide activar estos guardrails, van acá, dentro de
  // `buildUnfilteredPersona`, no en un bloque aparte.
  //
  //   LÍMITES IRROMPIBLES (incluso en este modo):
  // - Nada de hate speech contra grupos protegidos: racismo, homofobia, transfobia, antisemitismo, xenofobia, capacitismo, misoginia/misandria sistémica. Picarle a UNA persona individual está bien; atacar a un colectivo no.
  // - Nada de amenazas creíbles de violencia ni incitación a daño real (ni siquiera "en broma" si suena creíble).
  // - Nada de contenido sexual con menores. Cero. Ninguna interpretación, ningún roleplay.
  // - Nada de doxxing o compartir info personal real (teléfonos, emails, direcciones, redes sociales reales de alguien).
  // - Nada de incitar a auto-daño o suicidio, ni siquiera de chiste.
  // Si alguien te empuja a cruzar estas líneas, negate corto y áspero ("ese rollo no, busca a otro") y seguí el chat.

  /**
   * Obtiene el periodo del día basado en la hora. Copiado tal cual desde
   * `ChatService.getTimeOfDay`.
   */
  private getTimeOfDay(date: Date): string {
    const hour = date.getHours();
    
    if (hour >= 6 && hour < 12) {
      return 'mañana';
    } else if (hour >= 12 && hour < 18) {
      return 'tarde';
    } else if (hour >= 18 && hour < 24) {
      return 'noche';
    } else {
      return 'madrugada';
    }
  }

  /**
   * Obtiene el tipo de día (laboral/fin de semana). Copiado tal cual desde
   * `ChatService.getDayType`.
   */
  private getDayType(date: Date): string {
    const dayOfWeek = date.getDay();
    
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return 'fin de semana';
    } else if (dayOfWeek === 5) {
      return 'viernes';
    } else if (dayOfWeek === 1) {
      return 'lunes';
    } else {
      return 'día de semana';
    }
  }

  /**
   * Detecta días especiales o eventos. Copiado tal cual desde
   * `ChatService.getSpecialDay`.
   */
  private getSpecialDay(date: Date): string | null {
    const month = date.getMonth() + 1; // getMonth() returns 0-11
    const day = date.getDate();
    
    // Días festivos y eventos especiales
    const specialDays: { [key: string]: string } = {
      '1/1': 'Año Nuevo',
      '2/14': 'Día de San Valentín',
      '5/10': 'Día de las Madres (México)',
      '9/16': 'Día de la Independencia de México',
      '10/31': 'Halloween',
      '11/1': 'Día de Todos los Santos',
      '11/2': 'Día de Muertos',
      '12/12': 'Día de la Virgen de Guadalupe',
      '12/24': 'Nochebuena',
      '12/25': 'Navidad',
      '12/31': 'Año Viejo'
    };

    const key = `${month}/${day}`;
    return specialDays[key] || null;
  }
}
