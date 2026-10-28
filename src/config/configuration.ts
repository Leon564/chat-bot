/**
 * `parseInt` de un entero de `.env` con fallback seguro cuando el valor no es
 * numérico. Existe porque `parseInt('abc', 10)` da `NaN`, y `NaN ?? default`
 * NO cae al default (`NaN` no es nullish) — un operador editando el `.env` a
 * mano y tipeando mal `RATE_LIMIT_PER_HOUR` apagaba el guard de costo por
 * completo y en silencio: `NaN <= 0` es `false` (no toma la rama de
 * "desactivado") y `fresh.length >= NaN` es `false` SIEMPRE, así que nadie se
 * limitaba nunca, sin un solo log de aviso.
 */
function parseIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),

  // OpenAI Configuration
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
  },

  // Bot Configuration
  bot: {
    responseDelay: parseInt(process.env.RESPONSE_DELAY || '1000', 10),
    maxLengthResponse: parseInt(process.env.MAX_LENGTH_RESPONSE || '200', 10),
    useMemory: process.env.USE_MEMORY === 'true',
    // Optional hex color (without #) used to prefix bot messages, e.g. TEXT_COLOR=ff00aa
    textColor: process.env.TEXT_COLOR || '',
    // Personalidad del bot. 'default' = asistente educado.
    // 'unfiltered' = tono crudo, permite groserías e insultos jocosos.
    // Pensado para correr una segunda instancia del bot con su propia API key
    // en una dinámica con participantes adultos conscientes. Mantiene
    // guardrails irrompibles (sin hate speech a grupos, amenazas, menores,
    // doxxing — ver chat.service.ts).
    personality: (process.env.BOT_PERSONALITY === 'unfiltered' ? 'unfiltered' : 'default') as 'default' | 'unfiltered',
    // Tope de llamadas al modelo por usuario y por hora (ventana móvil,
    // ver RateLimitService). No limita los fast-paths deterministas
    // (música, video, usuarios online) ni los comandos !personality/
    // !quesabes/!olvida — ninguno de esos cuesta tokens. admin/superAdmin
    // nunca se limitan. RATE_LIMIT_PER_HOUR=0 desactiva el límite por
    // completo (todos pasan) — interruptor de emergencia sin tocar código.
    rateLimitPerHour: parseIntEnv(process.env.RATE_LIMIT_PER_HOUR, 20),
    // Contexto cruzado entre usuarios. Apagado por defecto: es opt-in.
    // Enciende tres capacidades a la vez — que el bot lea del grafo de OTROS
    // usuarios mencionados, que acepte hechos sobre terceros, y los recados
    // diferidos. Se puede mover en caliente con !contextocruzado (admin), sin
    // reiniciar — mismo rol de interruptor de emergencia que CACHE_ENABLED.
    crossUserContext: process.env.CROSS_USER_CONTEXT === 'true',
  },

  // Music Configuration
  music: {
    uploadService: process.env.UPLOAD_SERVICE || 'catbox',
    litterboxExpiry: process.env.LITTERBOX_EXPIRY || '1h',
    youtubeCookiesPath: process.env.YOUTUBE_COOKIES_PATH,
    maxDurationMinutes: parseInt(process.env.MAX_SONG_DURATION || '8', 10),
    // FileGarden uploader (https://filegarden.com). Optional; when both vars
    // are set, FileGarden is used as a last-ditch fallback after the regular
    // catbox/litterbox/nullpointer chain — and can be selected as the primary
    // via UPLOAD_SERVICE=filegarden. Auth cookie is harvested from the
    // browser session ("auth=..." cookie on filegarden.com).
    filegardenUserId: process.env.FILEGARDEN_USER_ID || '',
    filegardenAuthCookie: process.env.FILEGARDEN_AUTH_COOKIE || '',
    // Public share ID used in the file.garden CDN URL — distinct from the
    // user ID that goes into the private API endpoint. Visit any of your
    // public file URLs (file.garden/<this-id>/file.ext) to find it.
    // Falls back to FILEGARDEN_USER_ID when not set (some accounts share the
    // same value for both — see the Reddit ShareX tutorial).
    filegardenPublicId: process.env.FILEGARDEN_PUBLIC_ID || '',
  },

  // Video Configuration — !video command, disabled by default because uploads
  // are heavier than audio. MAX_VIDEO_DURATION caps duration to keep file
  // size manageable for catbox/litterbox.
  video: {
    enabled: process.env.VIDEO_ENABLED === 'true',
    maxDurationMinutes: parseInt(process.env.MAX_VIDEO_DURATION || '5', 10),
  },

  // Chat app connection
  chat: {
    apiUrl: process.env.CHAT_API_URL || 'http://localhost:3001',
    apiKey: process.env.CHAT_API_KEY || '',
  },

  // MongoDB connection — shared with the backend, but the bot uses bot_*
  // collection names to keep its data separate.
  database: {
    uri: process.env.MONGODB_URI || '',
  },

  // Graph cache (Fase 4a) — fichas de AniList y pistas ya subidas servidas
  // desde el grafo en vez de re-procesarse. CACHE_ENABLED=false apaga el
  // camino de lectura por completo (GraphCacheService.findWork/findTrack
  // devuelven null sin consultar Mongo), forzando siempre el pipeline
  // normal — pensado como interruptor de emergencia sin necesitar rollback.
  // Las escrituras (saveTranslation/invalidateTrack/ingest*) no se gatean:
  // persistir no hace daño aunque la lectura del caché esté apagada.
  graph: {
    cacheEnabled: process.env.CACHE_ENABLED !== 'false',
  },
});