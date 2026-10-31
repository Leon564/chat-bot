/**
 * `@distube/ytdl-core` v5 es sólo ESM y jest corre en CJS sin transformar
 * node_modules, así que no puede cargarlo. `moduleNameMapper` lo reemplaza por
 * este stub en toda la suite: ningún test debe llegar a descargar de verdad.
 */
export const Client = { WebEmbedded: 'web_embedded', Tv: 'tv' } as const;

export const Quality = { Highest: 'highest', HighestAudio: 'highestaudio' } as const;

export class Ytdl {
  download(): never {
    throw new Error('ytdl-core deshabilitado en tests');
  }
}
