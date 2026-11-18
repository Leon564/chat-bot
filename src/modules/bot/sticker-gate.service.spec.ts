import { ConfigService } from '@nestjs/config';
import { StickerGateService } from './sticker-gate.service';

function build(chance: number, cooldownMinutes = 5) {
  const config = {
    get: (key: string) =>
      key === 'bot.stickerChance' ? chance : key === 'bot.stickerCooldownMinutes' ? cooldownMinutes : undefined,
  } as unknown as ConfigService;
  const gate = new StickerGateService(config);
  let now = 1_000_000_000;
  gate.now = () => now;
  const advance = (ms: number) => { now += ms; };
  return { gate, advance };
}

describe('StickerGateService', () => {
  it.each([
    'bot mandame un sticker',
    'pasá un stiker porfa',
    'tirá unos stickers',
    'Aria un estiker de gatos',
  ])('detecta pedido explícito: %s', (text) => {
    expect(StickerGateService.isExplicitRequest(text)).toBe(true);
  });

  it('no confunde palabras parecidas', () => {
    expect(StickerGateService.isExplicitRequest('bot qué es un ticket')).toBe(false);
  });

  it('un pedido explícito ignora la probabilidad', () => {
    const { gate } = build(0);
    gate.random = () => 0.99;
    expect(gate.decide('bot mandame un sticker')).toBe('requested');
  });

  it('un pedido explícito ignora también el cooldown', () => {
    const { gate } = build(0.5);
    gate.markSent();
    expect(gate.decide('bot un sticker')).toBe('requested');
  });

  it('sale "optional" cuando el dado cae debajo de la probabilidad', () => {
    const { gate } = build(0.15);
    gate.random = () => 0.1;
    expect(gate.decide('bot cómo va')).toBe('optional');
    gate.random = () => 0.2;
    expect(gate.decide('bot cómo va')).toBe('none');
  });

  it('con probabilidad 0 no ofrece espontáneos', () => {
    const { gate } = build(0);
    gate.random = () => 0;
    expect(gate.decide('bot cómo va')).toBe('none');
  });

  it('respeta el cooldown global desde el último sticker enviado', () => {
    const { gate, advance } = build(1, 5);
    gate.random = () => 0;
    gate.markSent();
    advance(4 * 60_000);
    expect(gate.decide('bot hola')).toBe('none');
    advance(60_000);
    expect(gate.decide('bot hola')).toBe('optional');
  });

  it('ofrecer sin enviar no consume el cooldown', () => {
    const { gate } = build(1, 5);
    gate.random = () => 0;
    expect(gate.decide('bot hola')).toBe('optional');
    expect(gate.decide('bot hola')).toBe('optional');
  });
});
