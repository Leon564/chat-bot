import { Injectable, Logger } from '@nestjs/common';

export interface CatalogSticker {
  _id: string;
  name: string;
  code: string;
  categoryId?: string | null;
  isActive?: boolean;
}

export interface CatalogCategory {
  _id: string;
  name: string;
  icon?: string;
  order: number;
}

/** Minúsculas, sin acentos, sin puntuación ni emojis y con espacios colapsados. */
export function normalizeStickerName(name: string): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STICKER_TOKEN_RE = /:([a-zA-Z0-9_]+):/g;

/**
 * Catálogo de stickers que el bot puede entender y usar.
 *
 * Se llena desde el socket, no por REST: el backend manda en `init` (al
 * conectar) y en `stickersUpdated` (cuando un admin cambia algo) los stickers
 * activos del **set activo** junto con sus categorías. Eso deja fuera los
 * stickers privados del set de SuperAdmin sin ningún filtro extra, y mantiene
 * el catálogo al día sin reiniciar el bot.
 */
@Injectable()
export class StickerCatalogService {
  private readonly logger = new Logger(StickerCatalogService.name);
  private byCode = new Map<string, CatalogSticker>();
  private byName = new Map<string, CatalogSticker>();
  private stickers: CatalogSticker[] = [];
  private categories: CatalogCategory[] = [];
  /** Lista para el prompt, cacheada: se arma una vez por actualización del catálogo. */
  private promptListCache: string | null = null;

  update(stickers: CatalogSticker[] | undefined, categories: CatalogCategory[] | undefined): void {
    if (!Array.isArray(stickers)) return;
    this.stickers = stickers.filter((s) => s && s.code && s.name && s.isActive !== false);
    if (Array.isArray(categories)) this.categories = categories;
    this.byCode = new Map(this.stickers.map((s) => [s.code.toLowerCase(), s]));
    this.byName = new Map();
    for (const s of this.stickers) {
      const key = normalizeStickerName(s.name);
      // Ante nombres repetidos gana el primero (el de menor `order`).
      if (key && !this.byName.has(key)) this.byName.set(key, s);
    }
    this.promptListCache = null;
    this.logger.log(`🧩 Catálogo de stickers: ${this.stickers.length} stickers, ${this.categories.length} categorías`);
  }

  get size(): number {
    return this.stickers.length;
  }

  nameForCode(code: string): string | null {
    return this.byCode.get(code.toLowerCase())?.name ?? null;
  }

  /** Busca por nombre tolerando mayúsculas, acentos, comillas y puntuación. */
  findByName(name: string): CatalogSticker | null {
    const key = normalizeStickerName(name.replace(/^["'«“]+|["'»”]+$/g, ''));
    return key ? this.byName.get(key) ?? null : null;
  }

  /**
   * Texto legible de un mensaje para el modelo: un sticker deja de ser
   * `[sticker]` o `:stk_xxxxx:` y pasa a ser `[sticker: Gato llorando]`.
   * Los códigos que no están en el catálogo quedan tal cual.
   */
  describeContent(content: string, type?: string): string {
    if (type === 'sticker') {
      const code = /^:([a-zA-Z0-9_]+):$/.exec((content ?? '').trim())?.[1];
      const name = code ? this.nameForCode(code) : null;
      return name ? `[sticker: ${name}]` : '[sticker]';
    }
    if (!content || this.byCode.size === 0) return content;
    return content.replace(STICKER_TOKEN_RE, (match, code: string) => {
      const name = this.nameForCode(code);
      return name ? `[sticker: ${name}]` : match;
    });
  }

  /**
   * Nombres agrupados por categoría, una línea por categoría, separados con
   * " | " (varios nombres llevan comas). Los sin categoría van al final.
   */
  promptList(): string {
    if (this.promptListCache !== null) return this.promptListCache;
    const known = new Set(this.categories.map((c) => c._id));
    const lines: string[] = [];
    for (const c of [...this.categories].sort((a, b) => a.order - b.order)) {
      const names = this.stickers.filter((s) => s.categoryId === c._id).map((s) => s.name);
      if (names.length > 0) lines.push(`${c.name}: ${names.join(' | ')}`);
    }
    const others = this.stickers
      .filter((s) => !s.categoryId || !known.has(s.categoryId))
      .map((s) => s.name);
    if (others.length > 0) lines.push(`${lines.length > 0 ? 'Otros' : 'Stickers'}: ${others.join(' | ')}`);
    this.promptListCache = lines.join('\n');
    return this.promptListCache;
  }
}
