# 🎵 Sistema de Música del Bot - ACTUALIZADO

Este bot puede descargar y compartir música de YouTube automáticamente usando **@distube/ytdl-core** y **ffmpeg automático**.

## 🚀 Nuevas Características (v2.0)

### Librerías Utilizadas
- **@distube/ytdl-core**: Descarga de audio de YouTube (más confiable que MediaTube)
- **@ffmpeg-installer/ffmpeg**: FFmpeg automático (no necesitas instalarlo manualmente)
- **fluent-ffmpeg**: Conversión de audio a MP3
- **ytsr**: Búsqueda en YouTube
- **form-data**: Subida de archivos a catbox.moe

### Ventajas del Nuevo Sistema
- ✅ **Sin dependencias externas**: FFmpeg se instala automáticamente
- ✅ **Más confiable**: ytdl-core es más estable que MediaTube
- ✅ **Mejor calidad**: Descarga audio de la máxima calidad disponible
- ✅ **Conversión automática**: Convierte cualquier formato a MP3
- ✅ **Búsqueda inteligente**: Encuentra videos usando términos de búsqueda

## 📖 Cómo Usar

#### 1. Comando Directo
```
!music [nombre de la canción]
```
Ejemplo: `!music Bohemian Rhapsody Queen`

#### 2. Solicitudes Naturales
El bot detecta automáticamente solicitudes de música en lenguaje natural:

- `reproduce [canción]`
- `pon música de [artista]`
- `quiero escuchar [canción]`
- `busca la canción [nombre]`
- `canción de [artista]`
- `música de [artista]`
- `play music [nombre]`
- `play song [nombre]`

### Cómo Funciona

1. **Detección**: El bot detecta automáticamente cuando alguien solicita música
2. **Descarga**: Usa MediaTube para descargar audio de YouTube en formato MP3
3. **Subida**: Sube el archivo a catbox.moe para hosting
4. **Envío**: Responde con el formato `[audio]URL[/audio]` para que el chat reproduzca la música

### Características

- ✅ **Cola de procesamiento**: Múltiples solicitudes se procesan en orden
- ✅ **Mensajes informativos**: El bot confirma cuando está procesando
- ✅ **Manejo de errores**: Respuestas claras cuando algo falla
- ✅ **Formato compatible**: Usa el formato de audio del chat
- ✅ **Cookies de YouTube**: Soporte opcional para evitar limitaciones

### Configuración Opcional

#### Cookies de YouTube
Para evitar limitaciones de YouTube, puedes agregar cookies en:
```
auth_info/youtube-cookies.json
```

Formato:
```json
[
  {
    "name": "cookie_name",
    "value": "cookie_value",
    "domain": ".youtube.com",
    "path": "/",
    "secure": true,
    "httpOnly": false
  }
]
```

### Comandos de Debug (Solo para Leon564)

- `debug music` - Muestra el estado de la cola de música

### Dependencias Nuevas

- `mediatube` - Para descarga de música de YouTube
- `form-data` - Para subir archivos a catbox.moe

### Limitaciones

- Solo descarga audio (MP3)
- Depende de catbox.moe para hosting
- Procesamiento secuencial (una canción a la vez)
- Límites de YouTube pueden aplicar sin cookies

### Estructura de Archivos

```
src/
├── musicService.ts    # Servicio principal de música
├── index.ts          # Bot principal (modificado)
└── chatGpt.ts        # GPT (modificado con instrucciones de música)

auth_info/
└── youtube-cookies.json  # Cookies opcionales de YouTube
```

### Ejemplos de Uso

```
Usuario: !music Despacito Luis Fonsi
Bot: 🎵 Buscando y descargando "Despacito Luis Fonsi"... Esto puede tomar unos momentos.
Bot: 🎵 **Despacito - Luis Fonsi ft. Daddy Yankee**
     [audio]https://files.catbox.moe/abc123.mp3[/audio]
     _Solicitado por Usuario_

Usuario: reproduce something in the way nirvana
Bot: 🎵 Buscando y descargando "something in the way nirvana"... Esto puede tomar unos momentos.
Bot: 🎵 **Something In The Way - Nirvana**
     [audio]https://files.catbox.moe/def456.mp3[/audio]
     _Solicitado por Usuario_
```

### Notas de Desarrollo

- El servicio usa una cola para evitar sobrecargar YouTube
- Los archivos se suben a catbox.moe automáticamente
- El formato `[audio]URL[/audio]` es compatible con el chat
- El bot no procesa música a través de GPT para mayor velocidad
