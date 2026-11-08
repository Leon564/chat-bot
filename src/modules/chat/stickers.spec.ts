import { ChatService } from './chat.service';
import { PromptBuilderService, PromptInput } from './prompt-builder.service';

describe('ChatService.extractStickerVerb', () => {
  it('saca el verbo y devuelve el nombre', () => {
    expect(ChatService.extractStickerVerb('jaja pobre STICKER(Gato llorando)')).toEqual({
      content: 'jaja pobre',
      name: 'Gato llorando',
    });
  });

  it('tolera comillas, espacios y minúsculas', () => {
    expect(ChatService.extractStickerVerb('ok sticker( "Pepe hacker" )').name).toBe('Pepe hacker');
  });

  it('con varios, se queda con el primero y borra todos', () => {
    expect(ChatService.extractStickerVerb('STICKER(A) hola STICKER(B)')).toEqual({ content: 'hola', name: 'A' });
  });

  it('borra un STICKER( sin cerrar', () => {
    expect(ChatService.extractStickerVerb('listo STICKER(Gato')).toEqual({ content: 'listo', name: null });
  });

  it('no toca un texto sin el verbo', () => {
    const text = '  hola  che ';
    expect(ChatService.extractStickerVerb(text)).toEqual({ content: text, name: null });
  });

  it('deja intacto un SAVE_FACT que venía antes', () => {
    expect(ChatService.extractStickerVerb('Genial! SAVE_FACT(likes, Berserk) STICKER(Gato)').content).toBe(
      'Genial! SAVE_FACT(likes, Berserk)',
    );
  });
});

describe('PromptBuilderService — bloque de stickers', () => {
  const base: PromptInput = {
    botName: 'Aria',
    username: 'Nico',
    maxLength: 200,
    personality: 'default',
    useMemory: false,
    now: new Date('2026-11-08T12:00:00Z'),
    blocks: ['PERSONA'],
  };
  const builder = new PromptBuilderService();

  it('no aparece sin oferta', () => {
    expect(builder.build(base)).not.toContain('STICKERS DEL CHAT');
  });

  it('opcional: incluye la lista y la regla de "sólo si encaja"', () => {
    const out = builder.build({ ...base, stickers: { list: 'Pepe: Pepe hacker', requested: false } });
    expect(out).toContain('STICKERS DEL CHAT');
    expect(out).toContain('Pepe: Pepe hacker');
    expect(out).toContain('Es opcional');
  });

  it('pedido: le exige mandar uno', () => {
    const out = builder.build({ ...base, stickers: { list: 'Pepe: Pepe hacker', requested: true } });
    expect(out).toContain('Nico te pidió un sticker');
    expect(out).not.toContain('Es opcional');
  });
});
