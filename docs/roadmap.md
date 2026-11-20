# Roadmap del bot

Lista de trabajo que salió de la auditoría del 2026-11-20 (sobre `main` con el PR #18). Se va tachando a medida que se resuelve: marcá `[x]` y anotá el PR al lado.

Prioridad: 🔴 bug con impacto directo · 🟠 seguridad/dependencias · 🟡 limpieza · 🟢 mejora · ✨ novedad.

Orden sugerido: **1 + 2 + 3** → **6 + 8** (borrar el código muerto resuelve buena parte del audit) → **4 + 5** → el resto.

## 🔴 Correcciones importantes

- [x] **1. Un error de Mongo durante el manejo de un mensaje reinicia el bot.** El handler se registra sin `catch` (`bot.service.ts`, `chatSocketService.onMessage(...)`) y `main.ts` hace `process.exit(1)` ante cualquier `unhandledRejection`. `loggingService.saveLog` corre en *cada* mensaje: un parpadeo de Mongo tumba el proceso. Los comandos de instrucciones de sala (`quitar` / `reset` / lista) tampoco capturan errores de Mongo. **Arreglo:** `try/catch` con log en `handleNewChatMessage` (y que el proceso siga vivo). ✅ El handler del socket envuelve `handleNewChatMessage` en un `.catch` que loguea; el proceso sigue vivo.
- [x] **2. Detección de música con falsos positivos y sin mención.** `MusicService.isMusicRequest` busca subcadenas como `"tema de"`, `"música de"`, `"canción de"`, `"reproduce"` en cualquier mensaje, y el dispatcher deja pasar los pedidos de música sin nombrar al bot. Verificado: *"el tema de hoy es el torneo"*, *"me encanta la música de ese anime"* y *"quién reproduce el video?"* cuentan como pedidos. **Arreglo:** exigir mención al bot (o `!music`) para las frases naturales y sacar las frases ambiguas. ✅ Las frases naturales sólo cuentan con el bot nombrado (o reply); se sacaron las frases ambiguas, que ahora resuelve el modelo con `{{music:}}`.
- [x] **3. Música sin límite.** El camino rápido de música va antes del rate limit y la cola (`pending` en `music.service.ts`) no tiene tope global ni por usuario: un invitado puede encolar descargas y subidas sin fin. **Arreglo:** tope por usuario (p. ej. 1–2 pendientes) y global, más un cupo por hora para invitados. ✅ `MusicQuotaService`, todo configurable por `.env` (0 = sin tope): en camino por persona `MUSIC_MAX_PENDING_PER_USER` (2) y global `MUSIC_MAX_PENDING_GLOBAL` (8), cupo por hora `MUSIC_PER_HOUR` (invitados, 5) / `MUSIC_PER_HOUR_REGISTERED` (20); staff sin cupo por hora. Cubre también `!video` y los `{{music:}}` del modelo.
- [x] **4. `MAX_LENGTH_RESPONSE` (caracteres) se usa como `max_tokens`.** En `ChatService.chat`, 2000 → hasta ~8000 caracteres, que salen en varios mensajes y cuestan más. **Arreglo:** separar el tope de tokens del modelo (`MAX_COMPLETION_TOKENS`) del largo de cada mensaje del chat. ✅ `MAX_COMPLETION_TOKENS` (default 800).
- [x] **5. OpenAI sin timeout propio.** El SDK espera hasta 10 min y reintenta 2 veces. **Arreglo:** `new OpenAI({ timeout: 30_000, maxRetries: 1 })` (configurable). ✅ `OPENAI_TIMEOUT_MS` (30 s) y `OPENAI_MAX_RETRIES` (1).

## 🟠 Seguridad y dependencias

- [ ] **6. `npm audit --omit=dev`: 21 vulnerabilidades (2 críticas, 9 altas).** Varias vienen de dependencias sin uso (ver 8). `ws` vulnerable llega también vía `socket.io-client` → actualizarlo.
- [ ] **7. Reconexión del socket.** Intervalo fijo de 5 s, sin backoff: si el backend cae, el bot lo golpea cada 5 s para siempre. Un `joinError` (p. ej. rol quitado) sólo se loguea y el bot queda conectado pero sordo. **Arreglo:** backoff exponencial con tope y reintento/alerta ante `joinError`.

## 🟡 Limpieza

- [ ] **8. Código muerto heredado de CBox.**
  - `AuthService` / `AuthModule`: no se importan en ningún lado.
  - `MessagesService` y `OnlineUsersService`: registrados en `ChatModule`, nunca inyectados; hacen scraping de `cbox.ws`.
  - Paquetes sin uso: `ytsr`, `@nestjs/schedule` (trae el `uuid` vulnerable), `@nestjs/platform-ws`, `@nestjs/websockets`, `cheerio`, `ws` como dependencia directa. Revisar también `he` y `form-data` después de borrar lo anterior.
  - Interfaces de CBox en `common/interfaces` que queden huérfanas.
- [ ] **9. Migraciones viejas en cada arranque.** `MemoryService.migrateMemoriesToUserFormat` está vacía y `cleanExistingMemories` es del sistema `SAVE_MEMORY` ya reemplazado. Revisar también `MigrationService`.
- [ ] **10. Dos lockfiles** (`package-lock.json` + `pnpm-lock.yaml`). Quedarse con uno.
- [ ] **11. Scripts rotos.** `npm run lint` no tiene config de ESLint; `test:e2e` apunta a `test/jest-e2e.json`, que no existe.
- [ ] **12. `.env.example` desactualizado.** Faltan `OPENAI_BASE_URL`, `OPENAI_MODEL`, `TEXT_COLOR`, `CACHE_ENABLED`, `RATE_LIMIT_PER_HOUR`, `RATE_LIMIT_REGISTERED*`, `STICKER_*`, `X02_API_KEY`, `VIDEO_*`; sobran `GEMINI_API_KEY` y `CONTEXT_LENGTH`.
- [ ] **13. Doble manejo de SIGTERM** en `main.ts` (`enableShutdownHooks` + handler propio que vuelve a llamar `app.close()`).
- [ ] **14. ~160 `console.log`** (111 en `music.service.ts`) mezclados con el `Logger` de Nest. Pasarlos a `Logger` con niveles para poder apagar el debug en producción.
- [x] **Borrar los `.md` obsoletos de la raíz** (`COMPARISON.md`, `MESSAGE_VALIDATION_IMPLEMENTED.md`, `NESTJS_MIGRATION.md`, `MUSIC_README.md`): describían la migración desde CBox y librerías que ya no se usan.

## 🟢 Mejoras

- [ ] **15. Recados.** Sin cancelación (`!misrecados` / `!cancelarrecado`) ni índice TTL sobre `expiresAt`: los vencidos se acumulan en `bot_errands`. (`bot_llm_usage` no necesita TTL: `UsageService` ya lo poda a las últimas 5000 filas.)
- [ ] **16. Datos fijos en el código.** El comando `debug` se valida por el nombre `'Sleepy Ash'` en vez del rol admin. El bloque IDENTIDAD (`prompt-builder.service.ts`) tiene familia y reglas escritas a mano, con la regla "3." repetida. Moverlo a config o a instrucciones de sala.
- [ ] **17. Modelo por defecto `gpt-3.5-turbo`** (obsoleto). Además, para modelos de razonamiento `max_tokens` está deprecado (`max_completion_tokens`).
- [ ] **18. Archivos gigantes.** `music.service.ts` (2152 líneas), `bot.service.ts` (1746), `chat.service.ts` (1699). Candidatos: `CommandsService` para todos los `!…`, servicio propio para la cadena de subidas.
- [ ] **19. CI.** GitHub Action con `npx jest` + `npm run build` en cada PR.

## ✨ Novedades

- [x] **20. `!ayuda`** (también `!help` / `!comandos`): lista de comandos según el rol (general / staff / admin); `!video` sólo aparece si está activo.
- [x] **21. "Escribiendo…"** mientras el modelo responde: `ChatSocketService.startTyping()` reenvía `typing` cada 2,5 s (el gateway lo borra a los 3 s) y se corta en un `finally`, con tope de 60 s.
- [x] **22. `!uso [24h|7d|30d]` (admin)**: llamadas, tokens, top 5 de usuarios y costo estimado si se configuran `LLM_PRICE_INPUT_PER_M` / `LLM_PRICE_OUTPUT_PER_M`. Avisa si la ventana es más vieja que los registros (tope de 5000 filas).
- [x] **23. Instrucciones de sala con vencimiento** (`!instruccion 2h Respondé con colores`; acepta `m`/`min`, `h`/`horas`, `d`/`días`, de 1 minuto a 30 días). Se filtran al leer y además hay índice TTL. `!instrucciones` muestra cuánto falta. Las que crea el modelo (SAVE_INSTRUCTION) siguen siendo permanentes.
- [x] **24. Reacciones**: con `reactionsEnabled` encendido el prompt ofrece `REACT(emoji)`; el bot puede reaccionar además de responder, o sólo reaccionar. El emoji se valida (un pictograma, sin letras ni números) porque el gateway acepta cualquier string.

## Notas de trabajo

- **No correr el bot localmente para probar** (`node dist/main`, `npm run start:*`, ni `require('./dist/main.js')`): `.env` tiene credenciales reales y se conecta al chat en vivo como el bot de producción. Probar con `npx jest`.
