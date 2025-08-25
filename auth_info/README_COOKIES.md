# YouTube Cookies Configuration

## ¿Por qué usar cookies de YouTube?

Las cookies de YouTube permiten al bot acceder a:
- Contenido restringido por edad
- Videos solo disponibles para usuarios autenticados
- Videos con restricciones geográficas (dependiendo de la cuenta)
- Mejor estabilidad en las descargas

## Cómo obtener las cookies de YouTube

### Método 1: Usando las herramientas de desarrollador del navegador

1. **Abrir YouTube en tu navegador**
   - Ve a https://youtube.com
   - Inicia sesión con tu cuenta

2. **Abrir herramientas de desarrollador**
   - Presiona `F12` o `Ctrl+Shift+I`
   - Ve a la pestaña **Application** (Chrome) o **Storage** (Firefox)

3. **Encontrar las cookies**
   - En la barra lateral izquierda, expande **Cookies**
   - Haz clic en `https://www.youtube.com`

4. **Exportar cookies importantes**
   - Busca y copia los valores de estas cookies importantes:
     - `VISITOR_INFO1_LIVE`
     - `YSC`
     - `LOGIN_INFO`
     - `SID`
     - `HSID`
     - `SSID`
     - `APISID`
     - `SAPISID`

### Método 2: Usando extensiones del navegador

1. **Instalar una extensión de exportación de cookies**
   - Chrome: "Cookie Editor" o "EditThisCookie"
   - Firefox: "Cookie Editor"

2. **Exportar cookies de YouTube**
   - Ve a YouTube.com
   - Activa la extensión
   - Exporta las cookies en formato JSON

## Configuración

1. **Crear el archivo de cookies**
   ```bash
   cp auth_info/youtube-cookies.example.json auth_info/youtube-cookies.json
   ```

2. **Editar el archivo de cookies**
   - Abre `auth_info/youtube-cookies.json`
   - Reemplaza los valores de ejemplo con tus cookies reales

3. **Configurar la variable de entorno**
   - En tu archivo `.env`, asegúrate de tener:
   ```env
   YOUTUBE_COOKIES_PATH=./auth_info/youtube-cookies.json
   ```

## Formato del archivo JSON

```json
[
  {
    "name": "VISITOR_INFO1_LIVE",
    "value": "tu_valor_real_aqui",
    "domain": ".youtube.com",
    "path": "/",
    "secure": true,
    "httpOnly": false
  },
  // ... más cookies
]
```

## Seguridad

⚠️ **IMPORTANTE**: 
- **NUNCA** compartas tu archivo `youtube-cookies.json`
- Agrega `youtube-cookies.json` a tu `.gitignore`
- Las cookies contienen información sensible de tu cuenta
- Regenera las cookies si sospechas que han sido comprometidas

## Resolución de problemas

### Error: "Archivo de cookies no encontrado"
- Verifica que la ruta en `YOUTUBE_COOKIES_PATH` sea correcta
- Asegúrate de que el archivo `youtube-cookies.json` existe

### Error: "Formato de cookies inválido"
- Verifica que el JSON esté bien formateado
- Usa un validador JSON online para verificar la sintaxis

### Las cookies no funcionan
- Las cookies pueden expirar, obtén cookies frescas
- Asegúrate de estar logueado en YouTube al obtener las cookies
- Verifica que todas las cookies importantes estén incluidas

### Sin mejoras en el acceso
- Algunas restricciones no se pueden evitar solo con cookies
- El contenido puede estar bloqueado por otros motivos (derechos de autor, etc.)

## Logs de depuración

El bot mostrará información sobre el estado de las cookies:
- `🍪 [CONFIG] Cookies de YouTube cargadas exitosamente` - Cookies cargadas correctamente
- `🍪 [CONFIG] Sin cookies de YouTube - usando acceso público` - Sin cookies configuradas
- `🍪 [DESCARGA] Usando cookies personalizadas de YouTube` - Usando cookies para descarga
- `🔓 [DESCARGA] Usando acceso público a YouTube` - Sin cookies para descarga
