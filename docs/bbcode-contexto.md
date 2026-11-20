# Contexto: BBCodes del chat, para que el bot los use

> **Estado (2026-11-20): implementado.** Código en `src/common/bbcode/bbcode.ts` (+ spec),
> `src/modules/chat-socket/bbcode-settings.service.ts`, sección `FORMATO` en `PromptBuilderService`,
> `BotService.prepareOutgoing` / `splitForChat`. `MAX_LENGTH_RESPONSE` pasó a default 2000. La sección
> "Cosas a revisar" de abajo queda como referencia de lo que se hizo.

## Dónde vive cada cosa
- Lista oficial de BBCodes de formato y validación: `bbcode.ts`, archivo gemelo en
  `backend/src/chat/bbcode.ts` y `frontend/src/lib/bbcode.ts`
  (`FORMAT_BBCODES`, `findEmptyBbcode`, `isOnlyCaretColor`).
- Render en el widget: `frontend/src/components/chat/MessageItem.tsx`
  (`renderInlineParts` / `INLINE_TOKEN_RE`). Estilos `.bb-*` en `frontend/src/app/globals.css`.
- Interruptores del admin: `settings.disabledBbcodes` (se guardan los APAGADOS), panel `/admin/bbcode`.
- El bot envía con `ChatSocketService.sendMessage` → evento `sendMessage { content, type: 'text' }`,
  siempre a través de `BotService.sendBotMessage`, que antepone `^#<TEXT_COLOR> ` si está configurado.

## BBCodes de formato (los 12 que el admin puede apagar)
| Tag | Sintaxis | Se ve como |
|---|---|---|
| b | `[b]texto[/b]` | negrita |
| i | `[i]texto[/i]` | cursiva |
| u | `[u]texto[/u]` | subrayado |
| s | `[s]texto[/s]` | tachado |
| url | `[url=https://…]texto[/url]` o `[url]https://…[/url]` | link (solo http/https; otro esquema queda como texto plano) |
| quote | `[quote]texto[/quote]` | cita en bloque (renglón propio, raya a la izquierda) |
| code | `[code]texto[/code]` | monoespaciado; lo de adentro NO se interpreta (ni BBCode, ni stickers, ni menciones) |
| color | `[color=#rgb]texto[/color]` o `[color=#rrggbb]texto[/color]` | texto de color (solo hex de 3 o 6 dígitos) |
| spoiler | `[spoiler]texto[/spoiler]` o `\|\|texto\|\|` | oculto hasta tocarlo |
| big | `[big]texto[/big]` | texto 1.5× más grande |
| scroll | `[scroll]texto[/scroll]` | marquesina que rebota de lado a lado (ocupa su propio renglón) |
| shake | `[shake]texto[/shake]` | texto que tiembla (si es largo pasa a su propio renglón) |

Reglas de render:
- Mayúsculas/minúsculas da igual (`[B]x[/b]` funciona).
- Se pueden anidar tags DISTINTOS: `[b][i]hola[/i][/b]`, `[color=#f00][big]¡ojo![/big][/color]`.
- NO anidar el MISMO tag en sí mismo (`[b]a [b]b[/b] c[/b]` se rompe).
- Dentro de los tags siguen funcionando stickers `:codigo:`, menciones `<@usuario>`, URLs sueltas y
  `**negrita**` (salvo en `[code]`).
- Un tag mal cerrado o sin contenido válido se muestra como texto literal.

## Reglas que el bot DEBE respetar
1. **Nunca un BBCode vacío.** `[b][/b]` o `[b]   [/b]` (solo espacios) hace que el backend DESCARTE EN
   SILENCIO el mensaje entero: el bot "responde" y no aparece nada en el chat. Lo mismo un mensaje que es
   solo `^#hex`. Vale para los 12 tags, estén encendidos o apagados.
2. **Tags apagados por el admin.** Si un tag está en `disabledBbcodes`, el mensaje se guarda igual, pero el
   widget lo muestra como `[*]contenido`, sin formato. El bot no debería usarlos. La lista llega:
   - en el evento `init` del socket, dentro de `theme.disabledBbcodes` (array de nombres, p. ej.
     `["shake","scroll"]`);
   - en vivo con el evento `bbcodesState { disabled: string[] }` cuando el admin cambia algo.

   Mismo patrón que `StickerCatalogService`, que ya escucha `init`/`stickersUpdated`. Si falta el campo,
   están todos activos.
3. **Corte por largo.** `MAX_LENGTH_RESPONSE` (default 200) y `splitMessageIntoParts` pueden cortar un
   mensaje a la mitad de un tag: queda `[b]hola` en una parte y `mundo[/b]` en la otra (texto literal) o,
   peor, un tag vacío (regla 1). Cortar respetando tags (no partir dentro de un `[x]…[/x]`), o cerrar y
   reabrir en cada parte. Tope del servidor para el bot: `maxBotMessageLength` (default 2000).
4. **Color del bot.** El bot ya antepone `^#<TEXT_COLOR> ` a todo (estilo cbox). Eso colorea todo el
   mensaje y no depende del tag `[color]`. Dentro del texto también vale `^#rrggbb` (6 hex exactos):
   colorea desde ahí hasta el próximo `^#`. `[color=#hex]…[/color]` funciona encima del color del bot para
   destacar una parte.
5. **No abusar.** `[shake]`, `[scroll]` y `[big]` llaman mucho la atención: usarlos como énfasis puntual, no
   en cada respuesta. `[quote]` sirve para citar lo que dijo alguien; `[spoiler]` para finales o respuestas
   de trivia; `[code]` para comandos o texto literal.

## Otros tags que ya existen (NO son de formato, tienen sus propias reglas)
- Adjuntos: `[img]url[/img]`, `[audio thumb="…" title="…" artist="…"]url[/audio]`, `[video]url[/video]`.
  El bot ya los usa para la música (`MusicService.buildAudioBBCode`).
- `[youtube]url o id[/youtube]`: el bot SÍ puede (rol privilegiado), si `youtubeEmbedsEnabled` está activo.
- `[embed]url[/embed]`: solo admin/superAdmin; al bot se le quita el tag.
- `[wordle …]…[/wordle]`: el servidor lo borra de cualquier mensaje escrito; solo lo genera el juego.
- Saltos de línea: el bot puede usar `\n` siempre (a los usuarios se les colapsan salvo que el admin lo
  habilite).

## Cosas a revisar del lado del bot
- **Historial y memoria.** `sanitizeMemoryContent` (`src/common/utils/utils.service.ts`) y
  `normalizeMessageText` (`src/modules/chat-socket/reply-context.ts`) hoy solo limpian los adjuntos,
  `[color]` y `^#hex`. Los tags nuevos (`[b]`, `[shake]`, `[spoiler]`…) pasan crudos al contexto, a los
  hechos y a los recados. Conviene quitar las etiquetas y dejar el contenido. Para `[spoiler]`, decidir si
  el bot puede "ver" el contenido.
- **Mensajes de usuarios.** Llegan con BBCode crudo; el bot debería leerlos limpios. Referencia:
  `buildReplyExcerpt` en `backend/src/chat/content-preview.ts` ya quita las etiquetas de formato y colapsa
  los spoilers a `[spoiler]`.
- **Prompt.** Agregar al system prompt (`PromptBuilderService`) una sección corta con los tags disponibles
  (filtrando los apagados), su sintaxis y las reglas 1 a 5. Ejemplos: `[b]importante[/b]`,
  `[spoiler]el final[/spoiler]`, `[url=https://anilist.co/…]ficha[/url]`.
- **Red de seguridad antes de enviar.** Un validador en el bot que: borre tags vacíos, desarme los apagados
  (dejar el contenido) y verifique que los tags queden balanceados tras el corte por largo. Se puede copiar
  `findEmptyBbcode` del gemelo.
