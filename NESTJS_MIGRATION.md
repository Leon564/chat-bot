# CBox Bot - Arquitectura NestJS

Una refactorización completa del bot de CBox usando NestJS para una mejor organización, mantenibilidad y escalabilidad.

## 🏗️ Arquitectura

### Estructura del Proyecto

```
src-nestjs/
├── main.ts                    # Punto de entrada de la aplicación
├── app.module.ts             # Módulo principal
├── config/
│   └── configuration.ts      # Configuración centralizada
├── common/
│   ├── interfaces/           # Interfaces y tipos TypeScript
│   │   └── index.ts
│   └── utils/               # Servicios utilitarios
│       ├── utils.service.ts
│       ├── logging.service.ts
│       └── memory.service.ts
└── modules/
    ├── auth/                # Autenticación y detalles de CBox
    │   ├── auth.service.ts
    │   └── auth.module.ts
    ├── bot/                 # Servicio principal del bot
    │   ├── bot.service.ts
    │   └── bot.module.ts
    ├── chat/                # ChatGPT y manejo de mensajes
    │   ├── chat.service.ts
    │   ├── messages.service.ts
    │   └── chat.module.ts
    └── music/               # Servicio de música
        ├── music.service.ts
        └── music.module.ts
```

### Módulos Principales

#### 🤖 Bot Module
- **BotService**: Orquestador principal que coordina todos los servicios
- Maneja conexiones WebSocket
- Procesa mensajes entrantes
- Gestiona la cola de respuestas
- Renueva sesiones automáticamente

#### 🔐 Auth Module
- **AuthService**: Maneja autenticación con CBox
- Obtiene detalles de la caja de chat
- Gestiona sesiones de usuario

#### 💬 Chat Module
- **ChatService**: Integración con OpenAI GPT
- **MessagesService**: Envío y procesamiento de mensajes
- Manejo de memoria conversacional
- Generación de resúmenes

#### 🎵 Music Module
- **MusicService**: Procesamiento de solicitudes de música
- Búsqueda en YouTube
- Conversión de audio
- Subida a servicios de archivos

#### 🛠️ Common Utils
- **UtilsService**: Funciones utilitarias generales
- **LoggingService**: Gestión de logs y eventos
- **MemoryService**: Sistema de memoria conversacional

## 🚀 Migración desde la Versión Anterior

### Instalación de Dependencias

```bash
# Instalar nuevas dependencias de NestJS
npm install @nestjs/common @nestjs/core @nestjs/platform-express @nestjs/config @nestjs/schedule @nestjs/websockets @nestjs/platform-ws reflect-metadata rxjs

# Dependencias de desarrollo
npm install --save-dev @nestjs/cli @nestjs/schematics @nestjs/testing @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint eslint-config-prettier eslint-plugin-prettier jest prettier ts-jest ts-loader tsconfig-paths
```

### Configuración

1. **Actualizar package.json**: Usar `package-new.json` como referencia
2. **Configurar TypeScript**: Usar `tsconfig-new.json`
3. **Configurar NestJS CLI**: El archivo `nest-cli.json` ya está listo

### Scripts de Ejecución

```bash
# Desarrollo
npm run start:dev

# Producción
npm run build
npm run start:prod

# Debugging
npm run start:debug
```

## 🔧 Características Mejoradas

### Inyección de Dependencias
- Todas las dependencias se gestionan automáticamente por NestJS
- Mejor testabilidad y mantenimiento
- Configuración centralizada

### Manejo de Errores
- Manejo robusto de errores en cada módulo
- Reconexión automática de WebSocket
- Logging mejorado

### Escalabilidad
- Arquitectura modular permite fácil extensión
- Servicios desacoplados
- Configuración por environment

### Performance
- Lazy loading de módulos
- Optimización de memoria
- Pool de conexiones reutilizable

## 📝 Variables de Entorno

Todas las variables de entorno del proyecto original siguen siendo compatibles:

```env
# CBox Configuration
CBOX_URL=https://...
CBOX_USERNAME=tu_usuario
CBOX_PASSWORD=tu_password
CBOX_DEFAULT_PIC=url_imagen

# OpenAI
OPENAI_API_KEY=tu_api_key

# Bot Settings
RESPONSE_DELAY=20500
MAX_LENGTH_RESPONSE=200
TEXT_COLOR=ffffff
USE_MEMORY=true

# Music Settings
UPLOAD_SERVICE=catbox
LITTERBOX_EXPIRY=1h
YOUTUBE_COOKIES_PATH=./auth_info/youtube-cookies.json
```

## 🧪 Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
```

## 📦 Deployment

### Desarrollo
```bash
npm run start:dev
```

### Producción
```bash
npm run build
npm run start:prod
```

### Docker (opcional)
Se puede crear un Dockerfile para containerización:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
CMD ["node", "dist/main.js"]
```

## 🔄 Diferencias Principales

### Antes (Estructura Plana)
```
src/
├── index.ts          # Todo mezclado
├── chatGpt.ts        # Lógica dispersa
├── musicService.ts   # Sin inyección de dependencias
├── utils.ts          # Funciones globales
└── ...
```

### Después (Arquitectura Modular)
```
src-nestjs/
├── modules/          # Módulos separados por responsabilidad
├── common/           # Código compartido
├── config/           # Configuración centralizada
└── main.ts           # Bootstrap limpio
```

## 🎯 Beneficios de la Migración

1. **Mantenibilidad**: Código más organizado y fácil de mantener
2. **Testabilidad**: Cada servicio puede ser testeado independientemente
3. **Escalabilidad**: Fácil agregar nuevas funcionalidades
4. **Performance**: Mejor manejo de recursos y memoria
5. **Debugging**: Logs más estructurados y debugging más fácil
6. **Documentación**: Código auto-documentado con decoradores

## 🚨 Notas Importantes

- La funcionalidad existente se mantiene 100% compatible
- Todos los comandos y características funcionan igual
- La migración es transparente para los usuarios del bot
- Los datos existentes (logs, memoria) se mantienen en el mismo formato

## 🤝 Contribuciones

La nueva arquitectura facilita las contribuciones:

1. Cada módulo tiene su responsabilidad clara
2. Interfaces bien definidas
3. Testing estructurado
4. Documentación integrada