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
});