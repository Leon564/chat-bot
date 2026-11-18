import { normalizeStickerName, StickerCatalogService } from './sticker-catalog.service';

const CATS = [
  { _id: 'c2', name: 'Animalitos', icon: '🐾', order: 1 },
  { _id: 'c1', name: 'Reacciones', icon: '😂', order: 0 },
];
const STICKERS = [
  { _id: '1', name: 'Gato llorando', code: 'stk_aaaaa', categoryId: 'c2' },
  { _id: '2', name: 'Guácala, Dios me libre', code: 'stk_bbbbb', categoryId: 'c1' },
  { _id: '3', name: '¿Quién fue?', code: 'stk_ccccc', categoryId: null },
  { _id: '4', name: 'Inactivo', code: 'stk_ddddd', categoryId: 'c1', isActive: false },
];

function build() {
  const catalog = new StickerCatalogService();
  catalog.update(STICKERS, CATS);
  return catalog;
}

describe('normalizeStickerName', () => {
  it('ignora mayúsculas, acentos, signos y emojis', () => {
    expect(normalizeStickerName('¿Quién FUE? 🥲')).toBe('quien fue');
    expect(normalizeStickerName('  Guácala,   Dios me libre ')).toBe('guacala dios me libre');
  });
});

describe('StickerCatalogService', () => {
  it('descarta los inactivos', () => {
    expect(build().size).toBe(3);
    expect(build().nameForCode('stk_ddddd')).toBeNull();
  });

  it('describe un mensaje de tipo sticker por su nombre', () => {
    expect(build().describeContent(':stk_aaaaa:', 'sticker')).toBe('[sticker: Gato llorando]');
  });

  it('un sticker desconocido queda como [sticker]', () => {
    expect(build().describeContent(':stk_zzzzz:', 'sticker')).toBe('[sticker]');
  });

  it('traduce códigos dentro de un texto y deja intactos los desconocidos', () => {
    expect(build().describeContent('jaja :stk_aaaaa: a las 10:30: ok :nope:')).toBe(
      'jaja [sticker: Gato llorando] a las 10:30: ok :nope:',
    );
  });

  it('busca por nombre tolerando acentos, mayúsculas y comillas', () => {
    expect(build().findByName('"quien fue"')?.code).toBe('stk_ccccc');
    expect(build().findByName('GUACALA DIOS ME LIBRE')?.code).toBe('stk_bbbbb');
    expect(build().findByName('no existe')).toBeNull();
  });

  it('arma la lista del prompt por categoría en su orden, con los sin categoría al final', () => {
    expect(build().promptList()).toBe(
      'Reacciones: Guácala, Dios me libre\nAnimalitos: Gato llorando\nOtros: ¿Quién fue?',
    );
  });

  it('sin categorías, todo va a "Stickers"', () => {
    const catalog = new StickerCatalogService();
    catalog.update(STICKERS.slice(0, 2), []);
    expect(catalog.promptList()).toBe('Stickers: Gato llorando | Guácala, Dios me libre');
  });

  it('una actualización reemplaza el catálogo y la lista cacheada', () => {
    const catalog = build();
    expect(catalog.promptList()).toContain('Gato llorando');
    catalog.update([{ _id: '9', name: 'Foca', code: 'stk_foca1', categoryId: 'c2' }], undefined);
    expect(catalog.promptList()).toBe('Animalitos: Foca');
    expect(catalog.nameForCode('stk_aaaaa')).toBeNull();
  });

  it('ignora un payload sin lista de stickers', () => {
    const catalog = build();
    catalog.update(undefined, []);
    expect(catalog.size).toBe(3);
  });
});
