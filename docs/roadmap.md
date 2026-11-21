# Roadmap del bot

Lista de trabajo que salió de la auditoría del 2026-11-20 (sobre `main` con el PR #18). Se va tachando a medida que se resuelve: marcá `[x]` y anotá el PR al lado.

Prioridad: 🔴 bug con impacto directo · 🟠 seguridad/dependencias · 🟡 limpieza · 🟢 mejora · ✨ novedad.

Orden sugerido: **1 + 2 + 3** → **6 + 8** (borrar el código muerto resuelve buena parte del audit) → **4 + 5** → el resto.

## 🔴 Correcciones importantes

- [x] **1. Un error de Mongo durante el manejo de un mensaje reinicia el bot.** El handler se registra sin `catch` (`bot.service.ts`, `chatSocketService.onMessage(...)`) y `main.ts` hace `process.exit(1)` ante cualquier `unhandledRejection`. `loggingService.saveLog` corre en *cada* mensaje: un parpadeo de Mongo tumba el proceso. Los comandos de instrucciones de sala (`quitar` / `reset` / lista) tampoco capturan errores de Mongo. **Arreglo:** `try/catch` con log en `handleNewChatMessage` (y que el proceso siga vivo). ✅ El handler del socket envuelve `handleNewChatMessage` en un `.catch` que loguea; el proceso sigue vivo.
- [x] **2. Detección de música con falsos positivos y sin mención.** `MusicService.isMusicRequest` busca subcadenas como `"tema de"`, `"música de"`, `"canción de"`, `"reproduce"` en cualquier mensaje, y el dispatcher deja pasar los pedidos de música sin nombrar al bot. Verificado: *"el tema de hoy es el torneo"*, *"me encanta la música de ese anime"* y *"quién reproduce el video?"* cuentan como pedidos. **Arreglo:** exigir mención al bot (o `!music`) para las frases naturales y sacar las frases ambiguas. ✅ Las frases naturales sólo cuentan con el bot nombrado (o reply); se sacaron las frases ambiguas, que ahora resuelve el modelo con `{{music:}}`. Después se sumó `MusicIntentService`: sin nombrar al bot, "reproduce X" se atiende si un clasificador local (verbo al principio, sin señales de charla, o canción/artista conocido en el grafo) lo da por pedido.
- [x] **3. Música sin límite.** El camino rápido de música va antes del rate limit y la cola (`pending` en `music.service.ts`) no tiene tope global ni por usuario: un invitado puede encolar descargas y subidas sin fin. **Arreglo:** tope por usuario (p. ej. 1–2 pendientes) y global, más un cupo por hora para invitados. ✅ `MusicQuotaService`, todo configurable por `.env` (0 = sin tope): en camino por persona `MUSIC_MAX_PENDING_PER_USER` (2) y global `MUSIC_MAX_PENDING_GLOBAL` (8), cupo por hora `MUSIC_PER_HOUR` (invitados, 5) / `MUSIC_PER_HOUR_REGISTERED` (20); staff sin cupo por hora. Cubre también `!video` y los `{{music:}}` del modelo.
- [x] **4. `MAX_LENGTH_RESPONSE` (caracteres) se usa como `max_tokens`.** En `ChatService.chat`, 2000 → hasta ~8000 caracteres, que salen en varios mensajes y cuestan más. **Arreglo:** separar el tope de tokens del modelo (`MAX_COMPLETION_TOKENS`) del largo de cada mensaje del chat. ✅ `MAX_COMPLETION_TOKENS` (default 800).
- [x] **5. OpenAI sin timeout propio.** El SDK espera hasta 10 min y reintenta 2 veces. **Arreglo:** `new OpenAI({ timeout: 30_000, maxRetries: 1 })` (configurable). ✅ `OPENAI_TIMEOUT_MS` (30 s) y `OPENAI_MAX_RETRIES` (1).

## 🟠 Seguridad y dependencias

- [x] **6. `npm audit --omit=dev`: 21 vulnerabilidades (2 críticas, 9 altas).** ✅ Quedan 5 (2 altas, 3 moderadas, ninguna crítica): se borró el código muerto (8), se corrió `npm audit fix` (incluye `ws` vía `socket.io-client`, `mongoose` 9.12, `form-data`, `proxy-addr`), Nest a la última 10.x, y el bot arranca con `NestFactory.createApplicationContext` en vez de `create`, lo que permitió desinstalar `@nestjs/platform-express` (body-parser, multer, qs). Las 5 que quedan no son alcanzables desde el bot (ver 6b).
  - Ojo con los tests: `mongodb` ≥ 7.8 carga `os` con `import()` dinámico, que Jest (CJS) no soporta; `mongo-test.helper.ts` le pasa `runtimeAdapters: { os }`. En producción no hace falta.
- [x] **6b. Subir NestJS 10 → 12.** Resuelve las 5 restantes: `lodash` (alta) dentro de `@nestjs/config` — `_.template`/`_.unset`, sólo procesa nuestro `.env`; `file-type` dentro de `@nestjs/common` — sólo lo usa `ParseFilePipe`, que el bot no tiene; `@nestjs/core` — inyección en respuestas HTTP, y el bot ya no tiene HTTP. Es un salto de dos versiones mayores: hacerlo aparte, con el changelog a mano. ✅ Resuelto con **Nest 11** (última 11.2.11), no 12: Nest 12 es sólo ESM (`"type": "module"`) y su CLI pide TypeScript 6, así que subir implicaba migrar todo el bot (y Jest) a ESM. La 11.2.x ya trae los arreglos (`@nestjs/core` > 11.1.17, `file-type` 21.3.4 en `common`, `lodash` 4.18.1 en `@nestjs/config` 4.0.4): `npm audit --omit=dev` da **0**. Quedan 3 moderadas sólo en dev, dentro de `@nestjs/cli` 11 (`glob`/`minimatch`, corren al compilar sobre nuestros archivos); se van con la CLI 12, o sea con la migración a ESM.
- [x] **7. Reconexión del socket.** Intervalo fijo de 5 s, sin backoff: si el backend cae, el bot lo golpea cada 5 s para siempre. Un `joinError` (p. ej. rol quitado) sólo se loguea y el bot queda conectado pero sordo. **Arreglo:** backoff exponencial con tope y reintento/alerta ante `joinError`. ✅ Backoff exponencial 5 s → 5 min con 20 % de azar (`reconnectDelay`), se resetea al entrar al chat; un `joinError` suelta el socket y reintenta; la autenticación HTTP tiene timeout de 15 s. De paso: al apagar, `disconnect()` ya no programa otra reconexión (antes el bot se reconectaba durante el shutdown).

## 🟡 Limpieza

- [x] **8. Código muerto heredado de CBox.** ✅
  - Borrados `AuthService` / `AuthModule`, `MessagesService` y `OnlineUsersService` (scraping de `cbox.ws`), y las interfaces de CBox (`LoginParams`, `BoxDetails`, `SendMessageOptions`, `MessageData`, `OnlineUser*`, `BotSession`).
  - Desinstalados `cheerio`, `ws` (+ `@types/ws`), `@nestjs/schedule`, `@nestjs/platform-ws`, `@nestjs/websockets` y `@nestjs/platform-express` (+ `@types/express`).
  - Corrección de la auditoría: **`ytsr` sí se usa** (búsqueda de respaldo de YouTube en `music.service.ts`) y se queda; `he`, `form-data` y `node-fetch` también siguen en uso.
- [x] **9. Migraciones viejas en cada arranque.** `MemoryService.migrateMemoriesToUserFormat` está vacía y `cleanExistingMemories` es del sistema `SAVE_MEMORY` ya reemplazado. Revisar también `MigrationService`. ✅ Se borró `MemoryService` (nadie lo usaba; sólo corría su limpieza al arrancar). `MigrationService` se queda: es un no-op sin `data/*.json` y no hay forma de confirmar desde el repo que en el server ya se haya corrido.
- [x] **10. Dos lockfiles** (`package-lock.json` + `pnpm-lock.yaml`). ✅ Se borró `pnpm-lock.yaml`: los scripts y el deploy usan npm.
- [x] **11. Scripts rotos.** `npm run lint` no tiene config de ESLint; `test:e2e` apunta a `test/jest-e2e.json`, que no existe. ✅ `.eslintrc.js` con las reglas recomendadas de typescript-eslint (sin Prettier, `no-explicit-any` apagado); `npm run lint` da 0 y no corrige solo (`npm run lint:fix` sí). Se sacó `test:e2e`.
- [x] **12. `.env.example` desactualizado.** Faltan `OPENAI_BASE_URL`, `OPENAI_MODEL`, `TEXT_COLOR`, `CACHE_ENABLED`, `RATE_LIMIT_PER_HOUR`, `RATE_LIMIT_REGISTERED*`, `STICKER_*`, `X02_API_KEY`, `VIDEO_*`; sobran `GEMINI_API_KEY` y `CONTEXT_LENGTH`. ✅ Agregados `OPENAI_BASE_URL`, `OPENAI_MODEL`, `TEXT_COLOR`, `DISCORD_URL`, `CACHE_ENABLED` (los `RATE_LIMIT_*`, `STICKER_*`, `X02_API_KEY` y `VIDEO_*` ya estaban); quitados `GEMINI_API_KEY` y `CONTEXT_LENGTH`. `PORT` se sacó también del código.
- [x] **13. Doble manejo de SIGTERM** en `main.ts` (`enableShutdownHooks` + handler propio que vuelve a llamar `app.close()`). ✅ Queda sólo `enableShutdownHooks`.
- [x] **14. ~160 `console.log`** (111 en `music.service.ts`) mezclados con el `Logger` de Nest. Pasarlos a `Logger` con niveles para poder apagar el debug en producción. ✅ Los 159 `console.*` pasan por `createLog(contexto)` (`common/utils/log.ts`), que formatea como `console` (el `Logger` de Nest tomaría el último argumento como contexto) y respeta `LOG_LEVEL` (`error|warn|log|debug|verbose`, default `log`). Los `[DEBUG]` quedaron en nivel debug; el resto sigue en `log`, así que con el default se ve lo mismo que antes. Pendiente opcional: bajar a debug otros mensajes ruidosos (p. ej. la respuesta cruda del modelo en `ChatService`).
- [x] **Borrar los `.md` obsoletos de la raíz** (`COMPARISON.md`, `MESSAGE_VALIDATION_IMPLEMENTED.md`, `NESTJS_MIGRATION.md`, `MUSIC_README.md`): describían la migración desde CBox y librerías que ya no se usan.

## 🟢 Mejoras

- [x] **15. Recados.** Sin cancelación (`!misrecados` / `!cancelarrecado`) ni índice TTL sobre `expiresAt`: los vencidos se acumulan en `bot_errands`. (`bot_llm_usage` no necesita TTL: `UsageService` ya lo poda a las últimas 5000 filas.) ✅ `!misrecados` (los que dejaste, numerados), `!cancelarrecado <n>` y `!rechazarrecados` (borra sin leer los que hay para vos); los tres operan sólo sobre quien escribe. Índice TTL sobre `expiresAt`.
- [x] **16. Datos fijos en el código.** El comando `debug` se valida por el nombre `'Sleepy Ash'` en vez del rol admin. El bloque IDENTIDAD (`prompt-builder.service.ts`) tiene familia y reglas escritas a mano, con la regla "3." repetida. Moverlo a config o a instrucciones de sala. ✅ `debug` se valida por rol admin/superAdmin; arreglada la regla "3." repetida. La familia y las reglas siguen en el prompt (son contenido de la persona; si cambian, se pueden pisar con instrucciones de sala).
- [x] **17. Modelo por defecto `gpt-3.5-turbo`** (obsoleto). Además, para modelos de razonamiento `max_tokens` está deprecado (`max_completion_tokens`). ✅ Defaults `https://api.deepseek.com` + `deepseek-flash` (lo que usa el proyecto). Se sigue usando `max_tokens`, que DeepSeek acepta. De paso: se lee `prompt_cache_hit_tokens` de DeepSeek (antes la entrada cacheada quedaba en 0) y `!uso` puede cobrarla aparte con `LLM_PRICE_CACHED_INPUT_PER_M`.
- [x] **18. Archivos gigantes.** `music.service.ts` (2152 líneas), `bot.service.ts` (1746), `chat.service.ts` (1699). Candidatos: `CommandsService` para todos los `!…`, servicio propio para la cadena de subidas. ✅ `bot.service.ts` 2077 → 1270 (comandos a `BotCommandsService`, salida a `BotOutputService`), `music.service.ts` 2153 → 1326 (cadena de subidas a `UploadChainService`), `chat.service.ts` 1754 → 1162 (extractores de verbos a `ResponseVerbs`). Sin cambios de comportamiento.
- [x] **19. CI.** GitHub Action con `npx jest` + `npm run build` en cada PR. ✅ `.github/workflows/ci.yml`: `npm ci`, lint, typecheck, tests y build en cada PR y push a `main` (Node 24, caché del binario de mongod).

## ✨ Novedades

- [x] **20. `!ayuda`** (también `!help` / `!comandos`): lista de comandos según el rol (general / staff / admin); `!video` sólo aparece si está activo.
- [x] **21. "Escribiendo…"** mientras el modelo responde: `ChatSocketService.startTyping()` reenvía `typing` cada 2,5 s (el gateway lo borra a los 3 s) y se corta en un `finally`, con tope de 60 s.
- [x] **22. `!uso [24h|7d|30d]` (admin)**: llamadas, tokens, top 5 de usuarios y costo estimado si se configuran `LLM_PRICE_INPUT_PER_M` / `LLM_PRICE_OUTPUT_PER_M`. Avisa si la ventana es más vieja que los registros (tope de 5000 filas).
- [x] **23. Instrucciones de sala con vencimiento** (`!instruccion 2h Respondé con colores`; acepta `m`/`min`, `h`/`horas`, `d`/`días`, de 1 minuto a 30 días). Se filtran al leer y además hay índice TTL. `!instrucciones` muestra cuánto falta. Las que crea el modelo (SAVE_INSTRUCTION) siguen siendo permanentes.
- [x] **24. Reacciones**: con `reactionsEnabled` encendido el prompt ofrece `REACT(emoji)`; el bot puede reaccionar además de responder, o sólo reaccionar. El emoji se valida (un pictograma, sin letras ni números) porque el gateway acepta cualquier string.

## 🗣️ Uno más del chat (2026-11-21)

- [x] **25. `!resumen` ya no vacía el log.** Antes, cada resumen borraba `messages_log` y el bot se quedaba sin contexto de sala. Ahora el evento `Resumen` marca hasta dónde se resumió y el próximo arranca desde ahí (`LoggingService.getLastMessages(since)`).
- [x] **26. El bot ve sus propias respuestas.** `BotService.logOwnMessage` guarda en el log lo que contestó (con `@destinatario`, sin tokens) y los recados que entrega; el contexto de sala las marca como "(vos)". Los stickers de la gente se guardan por nombre (`[sticker: …]`). El bot nunca es sujeto de un hecho del resumen.
- [x] **27. Comentarios espontáneos.** Sin que lo nombren, con una charla viva (≥ 4 mensajes de ≥ 2 personas en 15 min), el bot puede meter un comentario corto: `PROACTIVE_CHANCE` (0.06 por mensaje, 0 apaga) y `PROACTIVE_COOLDOWN_MINUTES` (15, desde el último intento). El modelo puede pasar (`PASO`). Interruptor en caliente: `!proactivo on|off|reset|status` (admin).

## 📋 Pendientes

### Funciones nuevas
- [ ] **28. Recordatorios.** "bot recordame en 2h que…" / "avisame a las 9 que…": un recado para uno mismo con hora (en memoria + Mongo para sobrevivir reinicios; hora de El Salvador).
- [ ] **29. Encuestas con reacciones.** `!encuesta ¿Qué leemos? | Berserk | Vagabond`: publica las opciones con emojis, cuenta las reacciones (`reactionsState`) y anuncia el resultado al cerrar.
- [ ] **30. Trivia de anime/manga.** El bot lanza una pregunta, el primero que acierta suma un punto; ranking semanal.
- [ ] **31. `!resumen 2h` / `!resumen hoy`.** Resumen de un período en vez de "desde el último resumen" (el log ya no se vacía, pero se poda a 200 filas: para "hoy" haría falta un tope mayor o leer los mensajes del backend).

### Mantenimiento
- [ ] **32. % de caché en `!uso`.** Mostrar la proporción de tokens de entrada servidos desde caché (`prompt_cache_hit_tokens`) para confirmar el ahorro del orden del prompt (PR #22).
- [ ] **33. Latencia del modelo.** Registrar cuánto tarda cada llamada en `bot_llm_usage` y mostrar p50/p95 en `!uso`.
- [ ] **34. `!estado` (admin).** Conexión del socket, memoria del proceso, cola de música y si FileGarden / AniList responden.
- [ ] **35. Tests de `UploadChainService`** y tipar los `any` de la parte de música.
- [ ] **36. Migración a ESM + Nest 12 + TypeScript 6.** Grande y no urgente (ver 6b): saca las 3 moderadas de dev de `@nestjs/cli` 11.

## Notas de trabajo

- **No correr el bot localmente para probar** (`node dist/main`, `npm run start:*`, ni `require('./dist/main.js')`): `.env` tiene credenciales reales y se conecta al chat en vivo como el bot de producción. Probar con `npx jest`.
