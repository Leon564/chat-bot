import { PollService, POLL_DEFAULT_MS } from './poll.service';

describe('PollService', () => {
  it('parse: pregunta, opciones y duración opcional', () => {
    expect(PollService.parse('¿Qué leemos? | Berserk | Vagabond')).toEqual({
      question: '¿Qué leemos?',
      options: ['Berserk', 'Vagabond'],
      durationMs: POLL_DEFAULT_MS,
    });
    expect(PollService.parse('10m ¿Pizza? | sí | no')).toEqual({ question: '¿Pizza?', options: ['sí', 'no'], durationMs: 600_000 });
    expect(PollService.parse('2h ¿Peli? | a | b')).toEqual(expect.objectContaining({ durationMs: 7_200_000 }));
  });

  it.each(['¿Solo pregunta?', '¿Una? | sola', 'p | 1 | 2 | 3 | 4 | 5 | 6 | 7', '0m p | a | b', '25h p | a | b'])(
    'parse rechaza "%s"',
    (args) => {
      expect(PollService.parse(args)).toHaveProperty('error');
    },
  );

  it('render numera las opciones con emojis', () => {
    const text = PollService.render('leon', '¿Qué leemos?', ['Berserk', 'Vagabond'], 600_000);
    expect(text).toContain('Encuesta de leon: ¿Qué leemos?');
    expect(text).toContain('1️⃣ Berserk');
    expect(text).toContain('2️⃣ Vagabond');
    expect(text).toContain('10 min');
  });

  it('cuenta las reacciones del mensaje de la encuesta, sin los votos del bot', () => {
    const polls = new PollService();
    polls.botName = 'Aria';
    polls.start({ messageId: 'm1', author: 'leon', question: '¿Qué?', options: ['A', 'B'], endsAt: Date.now() + 60_000 }, () => {});
    polls.onReactions('otro', [{ emoji: '1️⃣', usernames: ['x', 'y', 'z'] }]);
    polls.onReactions('m1', [
      { emoji: '1️⃣', usernames: ['Aria', 'kei', 'lyna'] },
      { emoji: '2️⃣', usernames: ['Aria', 'kei'] },
      { emoji: '🔥', usernames: ['leon'] },
    ]);
    const r = polls.close()!;
    expect(r.counts).toEqual([{ option: 'A', votes: 2 }, { option: 'B', votes: 1 }]);
    expect(r.winners).toEqual(['A']);
    expect(r.totalVoters).toBe(2);
    expect(polls.current).toBeNull();
    expect(PollService.renderResult(r)).toContain('Ganó A');
  });

  it('empate y nadie votó', () => {
    const base = { messageId: 'm', author: 'leon', question: 'q', options: ['A', 'B'], endsAt: 0 };
    expect(PollService.tally({ ...base, reactions: [] }, 'Aria').winners).toEqual([]);
    expect(PollService.renderResult(PollService.tally({ ...base, reactions: [] }))).toContain('Nadie votó');
    const tie = PollService.tally(
      { ...base, reactions: [{ emoji: '1️⃣', usernames: ['kei'] }, { emoji: '2️⃣', usernames: ['lyna'] }] },
      'Aria',
    );
    expect(PollService.renderResult(tie)).toContain('Empate entre A y B');
  });

  it('cierra sola al vencer y avisa el resultado', () => {
    jest.useFakeTimers();
    try {
      const polls = new PollService();
      const onClose = jest.fn();
      polls.start({ messageId: 'm', author: 'leon', question: 'q', options: ['A', 'B'], endsAt: Date.now() + 60_000 }, onClose);
      jest.advanceTimersByTime(60_001);
      expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ question: 'q' }));
      expect(polls.current).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
