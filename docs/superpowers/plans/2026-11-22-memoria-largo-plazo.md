# Memoria a largo plazo de Aria — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aria guarda sola recuerdos de los usuarios registrados, los trae al prompt sólo cuando vienen al caso (por significado) y hace seguimientos de eventos con fecha.

**Architecture:** Módulo nuevo `src/modules/memory/` (datos, verbos puros, embeddings con fallback, recuperación, seguimientos). `ChatService.chat` le enseña los verbos al modelo, inyecta los recuerdos como dato y aplica lo que el modelo escribió; `BotService` entrega los seguimientos (tick de 30 s para el "antes", llegada del usuario para el "después"); `BotCommandsService` suma los comandos.

**Tech Stack:** NestJS 11, Mongoose 9, `openai` (ya instalado) para embeddings externos, `@huggingface/transformers` (nuevo) para el modelo local, Jest con `mongodb-memory-server` (`src/common/testing/mongo-test.helper.ts`).

**Spec:** `docs/superpowers/specs/2026-11-22-memoria-largo-plazo-design.md`

## Global Constraints

- Sólo registrados: roles `user`, `mod`, `admin`, `superAdmin`. Invitados y `bot`: ni verbos, ni recuerdos, ni seguimientos.
- `MEMORY_ENABLED` default `false`; override en caliente con `!memoria on|off|reset|status` (admin/superAdmin).
- Tipos: `event` | `fact` | `shared`. `text` máx. 200 caracteres; 3–6 `keywords` minúscula sin acentos; `eventDate` `YYYY-MM-DD` entre ayer y +1 año; `eventTime` `HH:mm`.
- Topes: 50 activos por persona; 5 recuerdos nuevos por persona por día; 1 seguimiento enviado por persona por día; tope 3 recuerdos por mensaje.
- Hora de El Salvador = UTC−6 fijo (mismo criterio que `ReminderService`).
- "Antes": 09:00 del día del evento; con hora, 2 h antes pero no antes de 08:00; si eso no queda antes del evento, 30 min antes. Si al guardar ya pasó, no se crea. Recuerdos `sensitive`: nunca "antes".
- "Después": disponible desde las 00:00 del día siguiente al evento; vence 5 días después.
- Un `event` pasa a `done` 7 días después de su fecha. Siempre elegibles: `event` con fecha entre ayer y +3 días.
- Embeddings externos: compatible OpenAI, `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL` (default `text-embedding-3-small`), `EMBEDDINGS_API_KEY`, timeout 3 s, sin reintentos; tras un fallo, no se reintenta por 10 min. Local: `EMBEDDINGS_LOCAL_MODEL` (default `Xenova/multilingual-e5-small`), cargado perezosamente, prefijos `query:` / `passage:`. Umbrales `EMBEDDINGS_THRESHOLD_EXTERNAL` / `EMBEDDINGS_THRESHOLD_LOCAL`.
- Vectores guardados por modelo (`ext:<modelo>` / `local:<modelo>`); nunca se compara entre modelos distintos.
- Los recuerdos entran como mensaje `role: 'user'` marcado como dato, nunca en el system prompt.
- Tests con vectores fijos: ningún test hace red ni carga el modelo local. No correr el bot localmente.

## Review Focus

- El modelo guarda dos veces el mismo recuerdo (lo vuelve a escribir el turno siguiente) → no se duplica; si cambió la fecha, se actualiza. *(Task 1)*
- `RECUERDO(evento | …)` con fecha relativa o mal formada ("viernes", "27/11") → se guarda como `fact`, sin seguimientos. *(Task 2)*
- Evento de hoy guardado después de la hora del "antes" → no sale un "suerte" tarde; sí queda el "después". *(Task 5)*
- `!olvida recuerdo <n>` sobre un evento con seguimientos pendientes → los seguimientos se cancelan. *(Task 8)*
- El modelo usa un id que no se le mostró (`RECUERDO_CERRADO(r9)`) o el de otra persona → se ignora. *(Task 6)*

---

### Task 1: Datos, configuración e interruptor

**Files:**
- Create: `src/common/schemas/bot-memory.schema.ts`, `src/common/schemas/bot-followup.schema.ts`
- Create: `src/modules/memory/memory.types.ts`, `src/modules/memory/memory-store.service.ts`, `src/modules/memory/memory-settings.service.ts`, `src/modules/memory/memory.module.ts`
- Modify: `src/config/configuration.ts` (bloque `memory`), `.env.example`
- Test: `src/modules/memory/memory-store.service.spec.ts`, `src/modules/memory/memory-settings.service.spec.ts`

**Interfaces:**
- Produces:
  - `type MemoryKind = 'event' | 'fact' | 'shared'`; `interface MemoryDraft { kind: MemoryKind; text: string; keywords: string[]; eventDate?: string; eventTime?: string; sensitive: boolean }`
  - Schema `BotMemory` (colección `bot_memories`): `user`, `kind`, `text`, `keywords`, `eventDate?`, `eventTime?`, `sensitive`, `embeddings: { model: string; vector: number[] }[]`, `status: 'active'|'done'|'cancelled'`, `useCount` (0), `lastUsedAt` (null), timestamps. Índice `{ user: 1, status: 1 }`.
  - Schema `BotFollowup` (colección `bot_followups`): `user`, `memoryId`, `phase: 'before'|'after'`, `dueAt`, `expiresAt`, `status: 'pending'|'sent'|'skipped'`, `sentAt?`. TTL sobre `expiresAt`; índice `{ status: 1, phase: 1, dueAt: 1 }`.
  - `MemoryStore`:
    - `create(username: string, draft: MemoryDraft, now?: Date): Promise<{ result: 'created' | 'updated' | 'duplicate' | 'daily_cap'; memory?: BotMemoryDocument }>`
    - `listActive(username: string, now?: Date): Promise<BotMemoryDocument[]>` — excluye `event` con fecha < hoy−7 (y los marca `done`).
    - `findOwned(username: string, id: string): Promise<BotMemoryDocument | null>`
    - `reschedule(id: string, eventDate: string, eventTime?: string): Promise<BotMemoryDocument | null>`, `close(id: string): Promise<void>`
    - `forgetByPosition(username: string, position: number): Promise<BotMemoryDocument | null>` (posición 1-based sobre `listActive`), `countActive(username)`, `forgetAll(username): Promise<number>`
    - `setEmbedding(id: string, model: string, vector: number[]): Promise<void>`, `markUsed(ids: string[], now?: Date): Promise<void>`
  - `MemorySettingsService` con `isEnabled(): boolean`, `setOverride(v: boolean | null)`, `getInfo(): { enabled: boolean; source: 'env' | 'override' }` — copia de `CrossContextSettingsService` leyendo `memory.enabled`.
  - Config `memory: { enabled, embeddings: { baseUrl, model, apiKey, localModel, thresholdExternal, thresholdLocal } }`. Umbrales default `0.45` (externo) y `0.82` (local) hasta calibrar.
  - `MemoryModule` exporta `MemoryStore`, `MemorySettingsService` (y lo que agreguen las tareas 3–5); importa `GraphModule` para `GraphService.normalizeUserKey`, con el que se normaliza `user`.

- [ ] **Step 1: Tests de `MemoryStore`** (Mongo en memoria):
  - `create` guarda con `user` normalizado y devuelve `created`.
  - Mismo `user` + mismo texto normalizado (minúsculas, sin acentos, espacios colapsados) → `duplicate`; si trae otra `eventDate` → `updated` con la fecha nueva.
  - El sexto `create` del mismo día local → `daily_cap`.
  - Con 50 activos, `create` borra el de menor `useCount`, después `lastUsedAt` más viejo, después `createdAt` más viejo, nunca un `event` con fecha ≥ hoy.
  - `listActive` no devuelve un `event` de hace 8 días y lo deja `done`; sí uno de hace 6.
  - `forgetByPosition(user, 2)` borra el segundo de `listActive`; posición inexistente → `null`.
- [ ] **Step 2:** `npx jest src/modules/memory/memory-store.service.spec.ts` → FAIL (módulo no existe).
- [ ] **Step 3: Implementar** schemas, tipos, `MemoryStore`, `MemorySettingsService`, config, `.env.example` (`MEMORY_ENABLED`, `EMBEDDINGS_*`) y `MemoryModule`.
- [ ] **Step 4: Test de `MemorySettingsService`** (mismos casos que `cross-context-settings.service.spec.ts`) y `npx jest src/modules/memory` → PASS.
- [ ] **Step 5:** `git commit -m "feat(memoria): colecciones, store e interruptor"`

### Task 2: Verbos y fechas (puro)

**Files:**
- Create: `src/modules/memory/memory-verbs.ts`, `src/modules/memory/memory-time.ts`
- Test: `src/modules/memory/memory-verbs.spec.ts`, `src/modules/memory/memory-time.spec.ts`

**Interfaces:**
- Consumes: `MemoryDraft`, `MemoryKind` (Task 1).
- Produces:
  - `extractMemoryVerbs(content: string): { content: string; saves: RawMemoryVerb[]; changes: { ref: string; eventDate: string; eventTime?: string }[]; closes: string[] }` — `RawMemoryVerb = string[]` (los campos crudos separados por `|`).
  - `validateMemoryDraft(fields: string[], now: Date): MemoryDraft | null`
  - `MEMORY_VERB_PATTERN_SOURCE: string` — para sumar a `ResponseVerbs.createLeftoverVerbRegex`.
  - `localDayKey(now: Date): string` (fecha local UTC−6), `localToUtc(day: string, time: string): Date`, `beforeDueAt(eventDate: string, eventTime?: string): Date`, `afterWindow(eventDate: string): { from: Date; expiresAt: Date }`

- [ ] **Step 1: Tests de verbos:**
  - `'Uh, suerte! RECUERDO(evento | Victoria rinde el examen de cálculo | examen, calculo, facultad | 2026-11-27 | 15:00 | no)'` → `content` = `'Uh, suerte!'`, un save con 6 campos.
  - `RECUERDO_CAMBIO(r1 | 2026-11-30)` y `RECUERDO_CERRADO(r2)` se extraen y se limpian; varios verbos en una misma respuesta se extraen todos.
  - Texto con comas y paréntesis balanceados dentro de un campo (`"rinde (otra vez) el parcial, ojalá"`) se conserva entero.
  - `validateMemoryDraft`: tipo `evento|dato|compartido` (y `event|fact|shared`) → `MemoryKind`; tipo desconocido o texto vacío → `null`; texto > 200 → recortado a 200; claves normalizadas y limitadas a 6 (con menos de 3 se aceptan igual); `delicado` = `si|sí|yes|true` → `sensitive: true`.
  - **Review Focus:** `evento` con fecha `viernes`, `27/11`, `2026-13-01`, anterior a ayer o posterior a +1 año → devuelve `kind: 'fact'` sin `eventDate`; hora inválida (`25:00`) → se descarta sólo la hora.
- [ ] **Step 2: Tests de fechas** (con `now = 2026-11-22T16:00:00Z`, 10:00 local):
  - `localDayKey(now)` = `'2026-11-22'`; a las `2026-11-23T05:30:00Z` sigue siendo `'2026-11-22'`.
  - `beforeDueAt('2026-11-27')` = `2026-11-27T15:00:00Z` (09:00 local).
  - `beforeDueAt('2026-11-27', '15:00')` = `2026-11-27T19:00:00Z` (13:00 local).
  - `beforeDueAt('2026-11-27', '09:00')` = `2026-11-27T14:00:00Z` (08:00 local, tope).
  - `beforeDueAt('2026-11-27', '08:10')` = `2026-11-27T13:40:00Z` (30 min antes).
  - `afterWindow('2026-11-27')` = `{ from: 2026-11-28T06:00:00Z, expiresAt: 2026-12-03T06:00:00Z }`.
- [ ] **Step 3:** `npx jest src/modules/memory/memory-verbs.spec.ts src/modules/memory/memory-time.spec.ts` → FAIL.
- [ ] **Step 4: Implementar** los dos archivos. Los verbos se cortan contando paréntesis (mismo enfoque que `ResponseVerbs.extractInstructionVerbs`) y se limpian con el mismo colapso de espacios.
- [ ] **Step 5:** tests → PASS; `git commit -m "feat(memoria): verbos RECUERDO y fechas"`

### Task 3: Embeddings con fallback

**Files:**
- Create: `src/modules/memory/embedding.service.ts`, `src/modules/memory/local-embedder.ts`
- Modify: `package.json` (`@huggingface/transformers`), `src/modules/memory/memory.module.ts`
- Test: `src/modules/memory/embedding.service.spec.ts`

**Interfaces:**
- Produces:
  - `interface LocalEmbedder { readonly model: string; embed(texts: string[]): Promise<number[][]> }` y token de inyección `LOCAL_EMBEDDER`; la implementación real (`TransformersLocalEmbedder`) importa `@huggingface/transformers` con `import()` dinámico en el primer `embed` (pipeline `feature-extraction`, `pooling: 'mean'`, `normalize: true`).
  - `type EmbedPurpose = 'query' | 'passage'`
  - `EmbeddingService.embed(texts: string[], purpose: EmbedPurpose): Promise<{ model: string; vectors: number[][] } | null>` — `model` es `ext:<EMBEDDINGS_MODEL>` o `local:<modelo local>`.
  - `EmbeddingService.embedWith(model: string, texts: string[], purpose: EmbedPurpose): Promise<number[][] | null>` — fuerza un modelo (para completar vectores faltantes).
  - `EmbeddingService.currentSource(): 'external' | 'local' | 'keywords'`, `thresholdFor(model: string): number`
  - `cosine(a: number[], b: number[]): number` exportada.

- [ ] **Step 1: Tests** (cliente externo y `LocalEmbedder` doblados):
  - Con key y externo OK → `model` = `ext:text-embedding-3-small`; el local no se llama.
  - Sin `EMBEDDINGS_API_KEY` → va directo al local, que recibe `'query: hola'` / `'passage: hola'`.
  - Externo lanza → usa el local; una segunda llamada dentro de los 10 min no toca el externo; pasados 10 min (reloj inyectable `now`) lo vuelve a probar.
  - Externo y local lanzan → `null`, y `currentSource()` = `'keywords'`.
  - `thresholdFor('ext:…')` / `thresholdFor('local:…')` devuelven los de config.
  - `cosine([1,0],[1,0])` = 1, `cosine([1,0],[0,1])` = 0, vector de ceros → 0.
- [ ] **Step 2:** `npx jest src/modules/memory/embedding.service.spec.ts` → FAIL.
- [ ] **Step 3: Implementar.** Externo: `new OpenAI({ baseURL, apiKey, timeout: 3000, maxRetries: 0 }).embeddings.create({ model, input })`. Registrar el uso con `UsageService` como `kind: 'embedding'` (sumar `'embedding'` a `LlmKind`/`LLM_KINDS` en `src/common/schemas/llm-usage.schema.ts`; `promptTokens` de `usage.prompt_tokens`, `completionTokens: 0`).
- [ ] **Step 4:** `npm install @huggingface/transformers`; tests → PASS; `npm run build` compila.
- [ ] **Step 5:** `git commit -m "feat(memoria): embeddings externos con fallback local"`

### Task 4: Recuperación

**Files:**
- Create: `src/modules/memory/memory-recall.service.ts`
- Modify: `src/modules/memory/memory.module.ts`
- Test: `src/modules/memory/memory-recall.service.spec.ts`

**Interfaces:**
- Consumes: `MemoryStore.listActive/setEmbedding/markUsed` (Task 1), `EmbeddingService` + `cosine` (Task 3), `localDayKey` (Task 2).
- Produces:
  - `interface RecalledMemory { ref: string; id: string; kind: MemoryKind; text: string; eventDate?: string; eventTime?: string }` — `ref` es `r1`, `r2`… en orden de aparición.
  - `MemoryRecallService.recall(username: string, text: string, now?: Date, opts?: { followUp?: string }): Promise<{ block: string; refs: Map<string, string> }>` — `refs` mapea `rN` → id; `block` vacío si no hay nada.
  - `MemoryRecallService.backfill(username: string): Promise<void>` — completa vectores faltantes del modelo vigente (fire-and-forget).
  - Constantes `MAX_RECALLED = 3`, `REPEAT_WINDOW_MS = 30 * 60_000`, `DIRECT_MARGIN = 0.08`.

- [ ] **Step 1: Tests** (embeddings doblados con vectores 2D/3D fijos, store real en Mongo en memoria):
  - Un `event` de mañana entra aunque el mensaje no se le parezca (vector ortogonal).
  - Un `fact` entra sólo si `cosine` ≥ umbral del modelo; por debajo, no.
  - Con 5 candidatos entran los 3 más parecidos, los "siempre elegibles" primero.
  - Recuerdo mostrado hace 10 min no vuelve a entrar; sí si su `cosine` ≥ umbral + 0.08; pasado 31 min vuelve a entrar.
  - Recuerdo sin vector del modelo vigente → se calcula con `embedWith`, se guarda con `setEmbedding` y se compara.
  - `embed` devuelve `null` → cae a palabras clave: entra el recuerdo con alguna `keyword` en las palabras normalizadas del mensaje.
  - `block` empieza con `[Recuerdos de <usuario> — usalos sólo si vienen al caso; no los recites]` y cada línea `rN (evento, viernes 27/11): <texto>` / `rN (dato): <texto>`; con `opts.followUp` agrega al final la nota `Preguntale cómo le fue con: <texto>`.
  - Los mostrados reciben `markUsed`.
- [ ] **Step 2:** `npx jest src/modules/memory/memory-recall.service.spec.ts` → FAIL.
- [ ] **Step 3: Implementar.** El vector de consulta se calcula sobre `text` (el llamador ya junta reply + mensaje). Mapa en memoria `user → (id → shownAt)` para la ventana de repetición.
- [ ] **Step 4:** tests → PASS.
- [ ] **Step 5:** `git commit -m "feat(memoria): recuperación por significado con piso de palabras clave"`

### Task 5: Seguimientos (datos)

**Files:**
- Create: `src/modules/memory/followup.service.ts`
- Modify: `src/modules/memory/memory.module.ts`, `src/modules/memory/memory-store.service.ts` (cancelar seguimientos al cerrar/olvidar)
- Test: `src/modules/memory/followup.service.spec.ts`

**Interfaces:**
- Consumes: `beforeDueAt`, `afterWindow`, `localDayKey` (Task 2), `BotFollowup` (Task 1).
- Produces:
  - `FollowupService.schedule(memory: BotMemoryDocument, now?: Date): Promise<void>` — sólo `event` con `eventDate`; "antes" si `!sensitive` y `beforeDueAt > now`; "después" siempre.
  - `FollowupService.reschedule(memory: BotMemoryDocument, now?: Date)` (cancela pendientes y vuelve a programar), `cancelFor(memoryId: string): Promise<void>`
  - `FollowupService.claimDueBefore(now?: Date): Promise<Array<{ user: string; memory: BotMemoryDocument }>>` — reclama de a uno con `findOneAndUpdate` (como `ReminderService.claimDue`); un "antes" cuyo evento ya pasó se marca `skipped`.
  - `FollowupService.claimAfter(username: string, now?: Date): Promise<BotMemoryDocument | null>` — el "después" disponible más viejo, si esa persona no recibió otro seguimiento hoy (`sentAt` en el día local).
  - `MemoryStore.close/forgetByPosition/forgetAll` llaman a `cancelFor`.

- [ ] **Step 1: Tests:**
  - Evento del 27/11 sin hora guardado el 22/11 → un "antes" a las `2026-11-27T15:00:00Z` y un "después" desde `2026-11-28T06:00:00Z`.
  - `sensitive` → sólo "después".
  - **Review Focus:** evento de hoy guardado a las 10:00 local → sin "antes", con "después".
  - `reschedule` a otra fecha deja sólo los dos nuevos pendientes.
  - `claimDueBefore` devuelve el vencido una sola vez aunque se llame dos veces seguidas.
  - `claimAfter` antes de `from` → `null`; después → el recuerdo; pasado `expiresAt` → `null`; si ese día ya se le mandó un "antes" → `null`.
  - `MemoryStore.close(id)` deja sus seguimientos en `skipped`.
- [ ] **Step 2:** `npx jest src/modules/memory/followup.service.spec.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** tests → PASS.
- [ ] **Step 5:** `git commit -m "feat(memoria): seguimientos antes y después de un evento"`

### Task 6: El modelo escribe y lee recuerdos (`ChatService` + prompt)

**Files:**
- Modify: `src/modules/chat/prompt-builder.service.ts` (`PromptInput.memory?: boolean`, bloque `blockMemory` en la parte variable, junto a `stickerRule`)
- Modify: `src/modules/chat/chat.service.ts` (opciones de `chat()`, carga en el `Promise.all`, inyección, extracción y aplicación)
- Modify: `src/modules/chat/response-verbs.ts` (`createLeftoverVerbRegex` / `stripLeftoverVerbs` cubren los verbos `RECUERDO*` con `MEMORY_VERB_PATTERN_SOURCE`)
- Modify: `src/modules/chat/chat.module.ts` (importa `MemoryModule`)
- Test: `src/modules/chat/chat.memory.spec.ts`, `src/modules/chat/prompt-builder.service.spec.ts`

**Interfaces:**
- Consumes: `MemorySettingsService.isEnabled`, `MemoryRecallService.recall` (Task 4), `MemoryStore.create/findOwned/reschedule/close` (Task 1), `FollowupService.schedule/reschedule` (Task 5), `extractMemoryVerbs`/`validateMemoryDraft` (Task 2).
- Produces: `chat()` acepta `options.memory?: { followUp?: string }` — presente sólo para registrados con la memoria encendida (lo arma `BotService`, Task 7).

- [ ] **Step 1: Tests** (`chat.memory.spec.ts`, servicios de memoria doblados salvo los verbos):
  - Sin `options.memory` → no se llama a `recall`, el prompt no menciona `RECUERDO` y un `RECUERDO(...)` en la respuesta se limpia sin guardar nada.
  - Con `options.memory` → el bloque de `recall` va como mensaje `user` después del contexto de sala y antes del reply/mensaje actual; `recall` recibe `replyTo.content + '\n' + message` si hay reply.
  - Respuesta con `RECUERDO(evento | … | 2026-11-27 | | no)` → `MemoryStore.create(username, draft)` y, si devuelve `created`/`updated` con `event`, `FollowupService.schedule`/`reschedule`; el texto que vuelve y el que se guarda en el historial no tienen el verbo.
  - `RECUERDO_CAMBIO(r1 | 2026-11-30)` con `r1` en `refs` → `reschedule` + `FollowupService.reschedule`. **Review Focus:** `r9` (no está en `refs`) o un id cuyo `findOwned(username, id)` da `null` → no se toca nada.
  - `RECUERDO_CERRADO(r1)` → `MemoryStore.close`.
  - `options.memory.followUp` llega a `recall(..., { followUp })`.
  - `recall` lanza → la respuesta sale igual, sin bloque.
- [ ] **Step 2: Test del prompt:** con `memory: true` aparece el bloque con los tres verbos, el formato con `|`, "sólo cosas tuyas, no de otras personas" y "marcá delicado lo de salud, familia o plata"; sin `memory` no aparece; el prefijo cacheable (bloques fijos) es idéntico con y sin `memory`.
- [ ] **Step 3:** `npx jest src/modules/chat/chat.memory.spec.ts src/modules/chat/prompt-builder.service.spec.ts` → FAIL.
- [ ] **Step 4: Implementar.** La extracción de memoria corre junto a la de `SAVE_INSTRUCTION` (antes de los extractores de `SAVE_FACT`). Los servicios de memoria se inyectan con `@Optional()` para no tocar los specs existentes de `ChatService`.
- [ ] **Step 5:** `npx jest src/modules/chat` → PASS (todos los specs de chat, no sólo los nuevos).
- [ ] **Step 6:** `git commit -m "feat(memoria): el modelo guarda, actualiza y recibe recuerdos"`

### Task 7: Entrega de seguimientos (`BotService`)

**Files:**
- Modify: `src/modules/chat/chat.service.ts` (`draftFollowUp`)
- Modify: `src/modules/bot/bot.service.ts` (opción `memory` al llamar a `chat()`, "después" en el punto de los recados, "antes" en el tick)
- Modify: `src/modules/bot/bot.module.ts` (importa `MemoryModule`)
- Test: `src/modules/bot/bot.memory.spec.ts`, `src/modules/chat/chat.memory.spec.ts`

**Interfaces:**
- Consumes: `FollowupService.claimDueBefore/claimAfter` (Task 5), `MemorySettingsService` (Task 1), `chat(..., { memory })` (Task 6).
- Produces: `ChatService.draftFollowUp(botName: string, username: string, memoryText: string, phase: 'before' | 'after'): Promise<string>` — patrón de `deliverErrand` (`blocks: ['PERSONA']`, el recuerdo como dato, una o dos frases); `''` si el modelo falla.

- [ ] **Step 1: Tests de `BotService`** (doblando `FollowupService` y `ChatService`):
  - Invitado con la memoria encendida → `chat()` sin `memory` y `claimAfter` no se llama.
  - Registrado (`user`) → `chat()` con `memory: {}`.
  - Registrado que le habla al bot con un "después" disponible → **un solo** mensaje: `chat()` recibe `memory: { followUp: <texto del recuerdo> }`.
  - Registrado que **no** le habla al bot con un "después" → se manda `draftFollowUp(..., 'after')` como mensaje propio con mención; si devuelve `''`, el texto fijo `<@usuario> ¿cómo te fue con lo de <texto>?`.
  - Tick: `claimDueBefore` con un recuerdo → `draftFollowUp(..., 'before')` con mención; si devuelve `''`, `<@usuario> ¡hoy es el día! Suerte con lo de <texto> 🍀`. Ambos quedan en el log de la sala (`logOwnMessage`).
  - Memoria apagada (`isEnabled` false) → ni `claimAfter` ni `claimDueBefore`.
- [ ] **Step 2: Test de `draftFollowUp`:** el pedido al modelo lleva el texto del recuerdo y la fase; el resultado pasa por `stripModelLeaks`.
- [ ] **Step 3:** `npx jest src/modules/bot/bot.memory.spec.ts` → FAIL.
- [ ] **Step 4: Implementar.** Roles registrados: `new Set(['user','mod','admin','superAdmin'])`. El `claimAfter` se hace en el punto de `deliverPendingErrand`; el resultado se usa más abajo: dentro de `chat()` si el mensaje sigue, o como mensaje propio en la rama donde el filtro de menciones descarta el mensaje. El "antes" se suma a `deliverDueReminders` (mismo intervalo).
- [ ] **Step 5:** `npx jest src/modules/bot` → PASS.
- [ ] **Step 6:** `git commit -m "feat(memoria): seguimientos con la voz de Aria"`

### Task 8: Comandos

**Files:**
- Modify: `src/modules/bot/bot-commands.service.ts`
- Test: `src/modules/bot/bot-commands.memory.spec.ts`

**Interfaces:**
- Consumes: `MemoryStore.listActive/forgetByPosition/countActive/forgetAll` (Task 1), `MemorySettingsService` (Task 1), `EmbeddingService.currentSource` (Task 3).

- [ ] **Step 1: Tests:**
  - `!quesabes` con recuerdos y sin hechos del grafo ya no dice "no tengo nada": muestra la sección `🧠 Lo que recuerdo:` numerada (`1. rinde el examen de cálculo (viernes 27/11)`), después de lo del grafo.
  - `!olvida recuerdo 2` borra el segundo y responde con su texto; número inexistente → aviso. **Review Focus:** borrar un evento con seguimientos los cancela (vía `MemoryStore`, verificado con el servicio real).
  - `!olvida todo` cuenta grafo + recuerdos; `!olvida todo si` borra ambos.
  - `!memoria on|off|reset|status` sólo admin/superAdmin (un `user` no recibe respuesta de comando); `status` dice encendida/apagada, origen (`env`/`override`) y la fuente (`externa`/`local`/`palabras clave`).
  - `!estado` incluye `memoria sí (externa)` / `memoria no` en los extras; `!ayuda` lista `!olvida recuerdo <n>` para todos y `!memoria` para admin.
  - `!uso` agrega `Embeddings: N llamadas` cuando hay filas `kind: 'embedding'` en la ventana.
- [ ] **Step 2:** `npx jest src/modules/bot/bot-commands.memory.spec.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** `npx jest` (suite completa) → PASS; `npm run lint` y `npm run build` limpios.
- [ ] **Step 5:** `git commit -m "feat(memoria): !quesabes, !olvida recuerdo y !memoria"`

### Task 9: Calibración y documentación

**Files:**
- Create: `test/fixtures/memory-recall.json`, `scripts/calibrate-memory.ts`
- Modify: `package.json` (script `calibrate:memory`), `docs/roadmap.md`, `.env.example`, `E:\Dev\chat\CLAUDE.md` (sección del bot; fuera del repo)

- [ ] **Step 1: Fixture** con ≥ 15 recuerdos ficticios en el estilo del chat (eventos, datos, compartidos) y ≥ 40 mensajes con lo esperado: `{ "message": "¿cómo va la facu?", "expect": ["examen-calculo"] }`, incluyendo ≥ 15 que no deben traer nada (música, saludos, chistes). Sin nombres reales.
- [ ] **Step 2: Script** `npm run calibrate:memory -- --source external|local`: calcula los vectores con la fuente pedida (usa las variables `EMBEDDINGS_*` del entorno; no se conecta a Mongo ni al chat), recorre umbrales de 0.30 a 0.95 en pasos de 0.01 e imprime aciertos, falsos positivos y el umbral recomendado (el más bajo con 0 falsos positivos). No corre en CI.
- [ ] **Step 3: Documentar** en el roadmap (ítem nuevo, hecho), `.env.example` y `CLAUDE.md`: qué es, que nace apagada, la secuencia para encenderla (cargar `EMBEDDINGS_API_KEY`, correr la calibración con las dos fuentes, poner los umbrales, `!memoria on`), y que el texto de los mensajes de registrados con recuerdos va al proveedor de embeddings.
- [ ] **Step 4:** `git commit -m "docs(memoria): calibración y puesta en marcha"`
