# Memoria a largo plazo de Aria — diseño

Fecha: 2026-11-22 · Estado: borrador para revisión

## Por qué

Aria tiene que hablar con más naturalidad y tomar decisiones propias. Hoy olvida todo lo personal: el historial dura 30 min y 4 intercambios por persona, y el grafo sólo sabe "le gusta / no le gusta / preguntó por" (en prod: 17 + 3 + 121 aristas de ese tipo, contra 4.500 de música). La vieja colección `memories` de texto libre (24 filas, p. ej. el lema "por los osos polares del desierto del Sahara") quedó como respaldo y nadie la lee.

El caso que define la feature: **Victoria cuenta que rinde un examen el viernes → Aria decide sola guardarlo → el viernes a la mañana le desea suerte → la próxima vez que Victoria escribe, le pregunta cómo le fue.**

## Objetivos

1. Aria **decide sola** qué recordar mientras charla, sin comandos.
2. Tres tipos de recuerdo: **evento** (con fecha: examen, viaje, cumpleaños), **dato** de la vida (el gato se llama Michi, empezó a trabajar), **compartido** (lema, chiste interno).
3. Un recuerdo entra al prompt **sólo cuando viene al caso** (por significado, no por palabra exacta).
4. **Seguimientos** de eventos con fecha (decisión del dueño, opción C):
   - *antes*: el día del evento, a las 9:00 (hora de El Salvador) o un rato antes si el evento tiene hora, un mensaje con mención aunque la persona no esté;
   - *después*: desde el día siguiente, la primera vez que la persona escribe, Aria pregunta cómo le fue.
   Los dos los redacta el modelo con la voz de Aria, no un texto fijo.
5. Si la persona cuenta un cambio ("lo pasaron al lunes", "ya lo rendí"), Aria actualiza o cierra el recuerdo y sus seguimientos.

## No objetivos

- Recuerdos para invitados (decisión del dueño: **sólo registrados** — `user/mod/admin/superAdmin`; un nombre de invitado lo puede tomar cualquiera y recibiría recuerdos ajenos). Los invitados siguen charlando igual.
- Reemplazar el grafo: gustos y música siguen ahí; la línea de contexto del grafo no se toca.
- Recuerdos sobre terceros ("Lyna rinde el viernes" dicho por León): fuera; un recuerdo es siempre de quien lo contó, sobre sí mismo o algo compartido con Aria.
- Migrar la colección `memories` vieja (se puede hacer después a mano; son 24 filas).

## Anti-objetivos (fallaría aunque "funcione")

- Que traiga un recuerdo a cada rato o en cualquier tema.
- Que saque algo delicado (salud, familia, plata) delante de otros o en el mensaje público de la mañana.
- Que pregunte por algo ya resuelto o vencido ("¿cómo te fue en el examen?" dos semanas después).
- Que se sienta como un sistema de avisos: mensajes de plantilla, o más de un seguimiento por persona por día.

## Enfoques considerados

1. **Palabras clave + fecha.** Barato, sin dependencias, testeable; falla con paráfrasis ("¿cómo va la facu?" no trae "examen de cálculo").
2. **Embeddings (por significado).** Entiende paráfrasis; necesita una fuente de vectores y calibrar un umbral.
3. **Índice siempre en el prompt.** Lo más simple, pero paga tokens siempre y empuja a usar los recuerdos de más (choca con el anti-objetivo 1).

**Elegido por el dueño: 2, con fuente externa y fallback local**, y el 1 como piso si fallan los dos.

## Diseño

### Datos

Colección `bot_memories` (una fila por recuerdo):

| campo | |
|---|---|
| `user` | clave normalizada del usuario (la misma que usa el grafo) |
| `kind` | `event` \| `fact` \| `shared` |
| `text` | una frase en tercera persona ("Victoria rinde el examen de cálculo") — máx. 200 caracteres |
| `keywords` | 3–6 palabras clave en minúscula, sin acentos (piso del fallback) |
| `eventDate` / `eventTime` | sólo `event`: `YYYY-MM-DD` y opcional `HH:mm` (hora de El Salvador) |
| `sensitive` | lo marca el modelo; ver "Delicado" |
| `embeddings` | `[{ model, vector }]` — un vector por modelo, nunca se mezclan |
| `status` | `active` \| `done` \| `cancelled` |
| `useCount`, `lastUsedAt`, `createdAt` | para podar y para no repetir |

Colección `bot_followups`: `{ user, memoryId, phase: 'before' | 'after', dueAt, expiresAt, status: 'pending' | 'sent' | 'skipped' }`. Separada de `bot_reminders` para que no aparezca en `!recordatorios` de la persona. TTL sobre `expiresAt`.

Topes: 50 recuerdos activos por persona (al pasarse se poda el de menos uso y más viejo, nunca un `event` futuro), 5 recuerdos nuevos por persona por día, 1 seguimiento enviado por persona por día. Un `event` pasa a `done` solo 7 días después de su fecha.

### Escritura: el modelo decide

- El prompt (sólo para registrados, como `canInstruct`) enseña:
  - `RECUERDO(tipo | texto | claves | fecha | hora | delicado)` — campos separados por `|` porque los textos llevan comas; `fecha`, `hora` y `delicado` opcionales. El prompt ya trae la fecha de hoy (bloque `TEMPORAL`), así que el modelo resuelve "el viernes" a `YYYY-MM-DD`.
  - `RECUERDO_CAMBIO(id | nueva fecha [| nueva hora])` y `RECUERDO_CERRADO(id)` sobre los recuerdos que se le mostraron (cada uno lleva un id corto, `r1`, `r2`… válido sólo en ese turno).
  - Cuándo guardar: cosas que importan a la persona y que tendría sentido retomar; no trivia del momento, no lo que ya está en los recuerdos mostrados.
- Extracción en `ResponseVerbs`, con el mismo cuidado que `STICKER`/`SAVE_INSTRUCTION`: corre **antes** de los extractores de `SAVE_FACT` (por la fusión de capturas), se limpia **siempre** del texto, y sólo se aplica si el autor es registrado. La barrida final (`stripLeftoverVerbs`) suma los tres verbos nuevos.
- El código valida: tipo conocido, texto no vacío, fecha válida y entre ayer y +1 año, hora `HH:mm`. Lo inválido se descarta en silencio (el texto de la respuesta ya salió limpio).
- Un `event` con fecha crea sus dos seguimientos al guardarse; `RECUERDO_CAMBIO` los reprograma; `RECUERDO_CERRADO` los cancela. Si el evento es hoy o ya pasó, no se crea el *antes*.

### Lectura: cuándo trae un recuerdo

En cada `chat()` de un registrado con recuerdos activos (`MemoryRecallService`):

1. **Siempre elegibles:** sus `event` con fecha entre ayer y dentro de 3 días.
2. **Por significado:** vector del mensaje (más el texto del reply, si hay) contra los vectores de sus recuerdos **del mismo modelo**; entran los que superan el umbral de ese modelo.
3. Orden por parecido, tope **3** recuerdos. Se descarta lo que ya se mostró en los últimos 30 minutos a esa persona, salvo que el mensaje lo nombre directamente (supera un umbral alto) — así no lo repite en cada turno.
4. Entran como mensaje `role: 'user'` marcado como dato (igual que el contexto de sala), **no** en el system prompt, para no romper la caché de prefijo. Formato: `[Recuerdos de Victoria — usalos sólo si vienen al caso; no los recites] r1 (evento, viernes 27/11): rinde el examen de cálculo`.

### Fuente de los vectores (con fallback)

`EmbeddingService.embed(texts)` devuelve `{ model, vectors }` o `null`:

1. **Externo** (normal): API compatible con OpenAI — `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL` (default `text-embedding-3-small`), `EMBEDDINGS_API_KEY`. Timeout corto (3 s), sin reintentos en el camino de respuesta.
2. **Local** (si el externo falla o no hay key): `multilingual-e5-small` con `@huggingface/transformers`, **cargado recién la primera vez que hace falta** (no ocupa RAM mientras el externo funcione). Con e5 los textos llevan los prefijos `query:` / `passage:`.
3. **Ninguno** (el local tampoco carga): búsqueda por `keywords` contra las palabras del mensaje (enfoque 1).

Reglas:
- Tras un fallo del externo se usa el local y el externo se reintenta cada 10 min (circuit breaker en memoria).
- Al usar un modelo con recuerdos que no tienen su vector, se calculan en el momento (son decenas) y se guardan. Los recuerdos guardados durante una caída reciben el vector externo cuando vuelve, en segundo plano.
- Umbral **por modelo** (`EMBEDDINGS_THRESHOLD_EXTERNAL`, `EMBEDDINGS_THRESHOLD_LOCAL`), calibrados con el set de prueba (abajo).
- La comparación es en memoria (coseno sobre los ≤50 recuerdos de esa persona); no hace falta Atlas Vector Search a este volumen.

### Seguimientos

- **Antes:** el tick de 30 s que ya corre para recordatorios reclama los `before` vencidos de a uno (`findOneAndUpdate`, igual que `claimDue`), pide al modelo una frase corta con la voz de Aria (patrón de `deliverErrand`, `blocks: ['PERSONA']`, el recuerdo como dato) y la manda con mención. Si el bot estuvo caído y el evento ya pasó, se salta.
- **Después:** al llegar un mensaje de la persona (mismo punto donde se entregan los recados), si tiene un `after` disponible y no recibió otro seguimiento hoy, Aria lo trae. Si ese mismo mensaje le habla al bot, la pregunta va **dentro** de la respuesta normal (como recuerdo "siempre elegible" con una nota de "preguntale cómo le fue"); si no le habla, va como mensaje propio. Vence a los 5 días.
- **Delicado:** un recuerdo `sensitive` nunca genera el *antes* público ni se menciona en un mensaje que no sea una respuesta a esa persona.

### Comandos y control

- `!quesabes` suma una sección "Lo que recuerdo" con los recuerdos activos numerados; `!olvida recuerdo <n>` borra uno (y sus seguimientos); `!olvida todo` borra también los recuerdos. Siempre sobre quien escribe.
- `MEMORY_ENABLED` (default `false`) + `!memoria on|off|reset|status` (admin), override en memoria como `!contextocruzado`. Con la memoria apagada no se enseñan los verbos, no se traen recuerdos y no salen seguimientos (los ya guardados se conservan).
- `!uso` cuenta las llamadas de embeddings aparte; `!estado` dice qué fuente se está usando (externa / local / palabras clave).

### Set de prueba y calibración

`bot/test/fixtures/memory-recall.json`: recuerdos de ejemplo + mensajes reales del chat (anonimizados) con lo esperado ("debería traer r1" / "no debería traer nada"). Un script de calibración corre el set contra cada modelo y propone el umbral que maximiza aciertos sin falsos positivos. Los tests de Jest usan vectores fijos (sin red ni modelo).

## Restricciones

- Un solo proceso (como recados e instrucciones): los topes por día y el circuit breaker viven en memoria.
- No correr el bot localmente contra prod (ver notas del roadmap); todo se prueba con Jest.
- DeepSeek no tiene embeddings; la fuente externa es otro proveedor. El texto de los mensajes de registrados con recuerdos viaja a ese proveedor.
- La dependencia del modelo local (`onnxruntime`) tiene que instalar y correr en el VPS; si no, queda el piso de palabras clave.

## Lo que queda para quien lo construya

- El texto exacto de las instrucciones del prompt y de los pedidos de frase para los seguimientos.
- Nombres de clases y archivos, dentro de las convenciones del bot (`modules/memory/` propuesto).
- Los valores iniciales de umbral (los fija la calibración).
- Si el borrado de `!olvida <algo>` (texto libre) también busca entre recuerdos por parecido, o sólo por número.
