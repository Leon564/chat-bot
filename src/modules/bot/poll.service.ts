import { Injectable } from '@nestjs/common';

export const POLL_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = POLL_EMOJIS.length;
export const POLL_DEFAULT_MS = 5 * 60_000;
export const POLL_MIN_MS = 60_000;
export const POLL_MAX_MS = 24 * 60 * 60_000;
export const POLL_MAX_QUESTION = 200;
export const POLL_MAX_OPTION = 80;

export interface Poll {
  messageId: string;
  author: string;
  question: string;
  options: string[];
  endsAt: number;
  /** Último estado de reacciones del mensaje (`messageReactionUpdated`). */
  reactions: { emoji: string; usernames: string[] }[];
}

export interface PollResult {
  question: string;
  author: string;
  counts: { option: string; votes: number }[];
  winners: string[];
  totalVoters: number;
}

/**
 * Una encuesta a la vez, en memoria (se pierde al reiniciar, como los demás
 * overrides del bot). Se vota reaccionando con 1️⃣ 2️⃣ … al mensaje del bot;
 * el backend difunde cada cambio con `messageReactionUpdated`, y acá se
 * guarda el último estado para contar al cerrar. Cada persona puede votar
 * más de una opción (no hay forma de saber cuál marcó primero); los votos
 * del propio bot (las reacciones que pone para que se vean los botones) no
 * cuentan.
 */
@Injectable()
export class PollService {
  private active: Poll | null = null;
  private timer: NodeJS.Timeout | null = null;

  /**
   * `!encuesta [10m] Pregunta | A | B`: devuelve la pregunta, las opciones y
   * la duración, o un mensaje de error para mostrar.
   */
  static parse(args: string): { question: string; options: string[]; durationMs: number } | { error: string } {
    let rest = (args ?? '').trim();
    let durationMs = POLL_DEFAULT_MS;
    const dur = /^(\d{1,4})\s*(m|min|mins|minutos?|h|hs|horas?)\s+/i.exec(rest);
    if (dur) {
      const n = Number(dur[1]);
      durationMs = n * (dur[2].toLowerCase().startsWith('h') ? 3_600_000 : 60_000);
      rest = rest.slice(dur[0].length);
      if (durationMs < POLL_MIN_MS || durationMs > POLL_MAX_MS) return { error: 'La duración va de 1 minuto a 24 horas.' };
    }
    const parts = rest.split('|').map((p) => p.trim()).filter((p) => p.length > 0);
    const [question, ...options] = parts;
    if (!question || options.length < POLL_MIN_OPTIONS) {
      return { error: 'Uso: !encuesta [10m] Pregunta | opción 1 | opción 2 (hasta 6 opciones)' };
    }
    if (options.length > POLL_MAX_OPTIONS) return { error: `Como mucho ${POLL_MAX_OPTIONS} opciones.` };
    if (question.length > POLL_MAX_QUESTION || options.some((o) => o.length > POLL_MAX_OPTION)) {
      return { error: `La pregunta va hasta ${POLL_MAX_QUESTION} caracteres y cada opción hasta ${POLL_MAX_OPTION}.` };
    }
    return { question, options, durationMs };
  }

  /** Texto del mensaje de la encuesta. */
  static render(author: string, question: string, options: string[], durationMs: number): string {
    const lines = options.map((o, i) => `${POLL_EMOJIS[i]} ${o}`);
    const mins = Math.round(durationMs / 60_000);
    const when = mins >= 60 && mins % 60 === 0 ? `${mins / 60} h` : `${mins} min`;
    return `📊 Encuesta de ${author}: ${question}\n${lines.join('\n')}\nVotá reaccionando con el número (cierra en ${when}).`;
  }

  get current(): Poll | null {
    return this.active;
  }

  /** Arranca la encuesta y programa el cierre. `onClose` recibe el resultado. */
  start(poll: Omit<Poll, 'reactions'>, onClose: (result: PollResult) => void): void {
    this.stopTimer();
    this.active = { ...poll, reactions: [] };
    const ms = Math.max(0, poll.endsAt - Date.now());
    this.timer = setTimeout(() => {
      const result = this.close();
      if (result) onClose(result);
    }, ms);
    this.timer.unref?.();
  }

  /** Guarda el último estado de reacciones si es el mensaje de la encuesta. */
  onReactions(messageId: string, reactions: { emoji: string; usernames: string[] }[]): void {
    if (!this.active || this.active.messageId !== messageId) return;
    this.active.reactions = Array.isArray(reactions) ? reactions : [];
  }

  /** Cierra la encuesta activa y devuelve el resultado (o null si no había). */
  close(botName?: string): PollResult | null {
    const poll = this.active;
    if (!poll) return null;
    this.stopTimer();
    this.active = null;
    return PollService.tally(poll, botName ?? this.botName);
  }

  /** Nombre del bot, para no contar sus propias reacciones. */
  botName: string | undefined;

  static tally(poll: Poll, botName?: string): PollResult {
    const bot = (botName ?? '').trim().toLowerCase();
    const voters = new Set<string>();
    const counts = poll.options.map((option, i) => {
      const r = poll.reactions.find((x) => x.emoji === POLL_EMOJIS[i]);
      const people = (r?.usernames ?? []).filter((u) => u && u.trim().toLowerCase() !== bot);
      people.forEach((u) => voters.add(u.trim().toLowerCase()));
      return { option, votes: people.length };
    });
    const max = Math.max(0, ...counts.map((c) => c.votes));
    const winners = max > 0 ? counts.filter((c) => c.votes === max).map((c) => c.option) : [];
    return { question: poll.question, author: poll.author, counts, winners, totalVoters: voters.size };
  }

  /** Texto del resultado. */
  static renderResult(r: PollResult): string {
    const lines = r.counts.map((c, i) => `${POLL_EMOJIS[i]} ${c.option} — ${c.votes} ${c.votes === 1 ? 'voto' : 'votos'}`);
    const verdict =
      r.winners.length === 0
        ? 'Nadie votó 🦗'
        : r.winners.length === 1
          ? `Ganó ${r.winners[0]} 🎉`
          : `Empate entre ${r.winners.join(' y ')} 🤝`;
    return `📊 Resultado: ${r.question}\n${lines.join('\n')}\n${verdict}`;
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
