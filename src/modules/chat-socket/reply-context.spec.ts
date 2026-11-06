import { ConfigService } from '@nestjs/config';
import { ChatMessage, ChatSocketService } from './chat-socket.service';
import { MAX_REPLY_CONTEXT_CHARS, normalizeMessageText } from './reply-context';

describe('normalizeMessageText', () => {
  it('saca el prefijo de color, los tags de color y los ángulos de mención', () => {
    expect(normalizeMessageText('^#ff00aa @Nico [color=#fff]hola[/color] <@kei>')).toBe('@Nico hola @kei');
  });

  it('colapsa multimedia, wordle y stickers a marcadores', () => {
    expect(normalizeMessageText('mirá [img]https://x/y.png[/img]')).toBe('mirá [media]');
    expect(normalizeMessageText('[wordle date="2026-01-01" score="2/6"]00002|22222[/wordle]')).toBe('[wordle]');
    expect(normalizeMessageText('https://cdn/sticker.png', 'sticker')).toBe('[sticker]');
  });

  it('corta los textos muy largos', () => {
    const largo = 'a'.repeat(MAX_REPLY_CONTEXT_CHARS + 50);
    const out = normalizeMessageText(largo);
    expect(out.length).toBe(MAX_REPLY_CONTEXT_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('ChatSocketService.getReplyContext', () => {
  type ConBuffer = { rememberMessage(msg: ChatMessage): void };

  const base = (over: Partial<ChatMessage>): ChatMessage => ({
    _id: 'x',
    content: '',
    authorUsername: 'Nico',
    type: 'text',
    createdAt: new Date().toISOString(),
    ...over,
  });

  let service: ChatSocketService;
  beforeEach(() => {
    service = new ChatSocketService({ get: () => undefined } as unknown as ConfigService);
  });

  it('sin replyTo devuelve null', () => {
    expect(service.getReplyContext(base({ content: 'hola' }))).toBeNull();
  });

  it('usa el texto completo del buffer cuando el padre pasó por el socket', () => {
    const largo = `^#123456 ${'palabra '.repeat(30)}fin`;
    (service as unknown as ConBuffer).rememberMessage(base({ _id: 'p1', authorUsername: 'kei', content: largo }));

    const ctx = service.getReplyContext(
      base({
        content: 'bot qué opinás?',
        replyTo: { messageId: 'p1', authorUsername: 'kei', authorColor: '#fff', contentExcerpt: 'palabra palabra' },
      }),
    );

    expect(ctx).toEqual({ author: 'kei', content: `${'palabra '.repeat(30)}fin` });
  });

  it('cae al excerpt del snapshot cuando el padre no está en el buffer', () => {
    const ctx = service.getReplyContext(
      base({
        content: 'bot qué opinás?',
        replyTo: { messageId: 'viejo', authorUsername: 'kei', authorColor: '#fff', contentExcerpt: 'leyendo Berserk' },
      }),
    );

    expect(ctx).toEqual({ author: 'kei', content: 'leyendo Berserk' });
  });

  it('el buffer descarta los mensajes más viejos al llenarse', () => {
    const svc = service as unknown as ConBuffer;
    svc.rememberMessage(base({ _id: 'primero', authorUsername: 'kei', content: 'texto completo original' }));
    for (let i = 0; i < 600; i++) svc.rememberMessage(base({ _id: `m${i}`, content: `m${i}` }));

    const ctx = service.getReplyContext(
      base({
        replyTo: { messageId: 'primero', authorUsername: 'kei', authorColor: '#fff', contentExcerpt: 'texto' },
      }),
    );

    expect(ctx?.content).toBe('texto');
  });
});
