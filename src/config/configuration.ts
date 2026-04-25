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
  },

  // Music Configuration
  music: {
    uploadService: process.env.UPLOAD_SERVICE || 'catbox',
    litterboxExpiry: process.env.LITTERBOX_EXPIRY || '1h',
    youtubeCookiesPath: process.env.YOUTUBE_COOKIES_PATH,
    maxDurationMinutes: parseInt(process.env.MAX_SONG_DURATION || '8', 10),
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
});