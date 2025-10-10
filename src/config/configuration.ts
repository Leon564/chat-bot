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
  },
});