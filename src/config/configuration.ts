export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  
  // CBox Configuration
  cbox: {
    url: process.env.CBOX_URL,
    username: process.env.CBOX_USERNAME,
    password: process.env.CBOX_PASSWORD,
    defaultPic: process.env.CBOX_DEFAULT_PIC,
  },
  
  // OpenAI Configuration
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model : process.env.OPENAI_MODEL || 'gpt-3.5-turbo',  
  },
  
  // Bot Configuration
  bot: {
    responseDelay: parseInt(process.env.RESPONSE_DELAY || '20500', 10),
    maxLengthResponse: parseInt(process.env.MAX_LENGTH_RESPONSE || '200', 10),
    textColor: process.env.TEXT_COLOR,
    useMemory: process.env.USE_MEMORY === 'true',
  },
  
  // Music Configuration
  music: {
    uploadService: process.env.UPLOAD_SERVICE || 'catbox',
    litterboxExpiry: process.env.LITTERBOX_EXPIRY || '1h',
    youtubeCookiesPath: process.env.YOUTUBE_COOKIES_PATH,
    maxDurationMinutes: parseInt(process.env.MAX_SONG_DURATION || '8', 10),
  },
});