import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as fs from "fs";
import * as path from "path";
import * as FormData from "form-data";
import fetch from "node-fetch";
import { createLog } from '../../common/utils/log';

const log = createLog('UploadChainService');

/**
 * La cadena de subida de canciones y videos: primario configurable
 * (`UPLOAD_SERVICE`), X02 como segunda opción si hay key, y fallbacks
 * (catbox → litterbox → 0x0 → uguu…, FileGarden como último recurso).
 * Salió de `MusicService`, que quedó con la búsqueda, la descarga y la cola.
 */
@Injectable()
export class UploadChainService {
  private uploadService: "catbox" | "litterbox" | "nullpointer" | "filegarden" | "uguu";
  private litterboxExpiry: string;
  // testConnectivity() pinged dns.google before every upload, which added a
  // 5s round-trip per file even when the network was clearly fine (we'd just
  // succeeded a previous upload seconds earlier). Cache the OK result for
  // CONNECTIVITY_TTL_MS so back-to-back queue items skip the re-check.
  private lastConnectivityOk: number = 0;
  private readonly CONNECTIVITY_TTL_MS = 60_000;

  constructor(private readonly configService: ConfigService) {
    // Configurar servicio de subida desde variables de entorno
    this.uploadService =
      (this.configService.get<string>("music.uploadService") as
        | "catbox"
        | "litterbox"
        | "nullpointer"
        | "filegarden") || "catbox";
    this.litterboxExpiry =
      this.configService.get<string>("music.litterboxExpiry") || "1h";

    log.info(`🔧 [CONFIG] Servicio de subida: ${this.uploadService}`);
    if (this.uploadService === "litterbox") {
      log.info(`🔧 [CONFIG] Expiración Litterbox: ${this.litterboxExpiry}`);
    }
  }

  /** Sube el archivo por la cadena configurada y devuelve la URL pública. */
  async uploadFile(filePath: string): Promise<string> {
    // Verificar conectividad básica antes de intentar uploads — pero sólo
    // si no la confirmamos en los últimos CONNECTIVITY_TTL_MS. Antes este
    // chequeo se hacía por cada archivo subido, gastando ~5s por canción
    // aunque la red estuviera claramente bien.
    if (Date.now() - this.lastConnectivityOk > this.CONNECTIVITY_TTL_MS) {
      log.info(`🌐 [CONNECTIVITY] Verificando conectividad de red...`);
      try {
        await this.testConnectivity();
        this.lastConnectivityOk = Date.now();
        log.info(`✅ [CONNECTIVITY] Conectividad verificada`);
      } catch (connectivityError) {
        log.error(`❌ [CONNECTIVITY] Sin conectividad de red:`, connectivityError instanceof Error ? connectivityError.message : connectivityError);
        throw new Error(`❌ Sin conectividad a internet. Verifica tu conexión de red.`);
      }
    }

    // Intentar según prioridad configurada
    const maxRetries = 3;
    const retryDelay = 2000;

    if (this.uploadService === "uguu") {
      log.info(`📤 [UPLOAD] Intentando subir a uguu.se primero (configurado)...`);

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          log.info(`📤 [UGUU] Intento ${attempt}/${maxRetries} - Subiendo archivo...`);
          return await this.uploadToUguu(filePath);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error(`❌ [UGUU] Error en intento ${attempt}:`, errorMsg);

          if (attempt === maxRetries) {
            log.info(
              `🔄 [FALLBACK] uguu.se falló tras ${maxRetries} intentos, probando Catbox...`,
            );
            break;
          }
          if (attempt < maxRetries) {
            const delay = errorMsg.includes("ENOTFOUND") ? retryDelay * 2 : retryDelay;
            log.info(`⏱️ Esperando ${delay}ms antes del siguiente intento...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      // Cadena de fallback: X02 (si está configurado) → Catbox → Litterbox →
      // FileGarden (último recurso si está configurado).
      const x02 = await this.tryX02Fallback(filePath);
      if (x02) return x02;
      try {
        const result = await this.uploadToCatboxWithRetry(filePath);
        log.info(`✅ [FALLBACK] Archivo subido exitosamente a Catbox`);
        return result;
      } catch (catboxError) {
        const catboxMsg =
          catboxError instanceof Error ? catboxError.message : String(catboxError);
        log.error(`❌ [FALLBACK] Catbox también falló:`, catboxMsg);
        try {
          const result = await this.uploadToLitterboxFallback(filePath);
          log.info(`✅ [FALLBACK] Archivo subido a Litterbox como último recurso`);
          return result;
        } catch (litterError) {
          const litterMsg =
            litterError instanceof Error ? litterError.message : String(litterError);
          const fg = await this.tryFileGardenLastResort(filePath);
          if (fg) return fg;
          if (litterMsg.includes("ENOTFOUND") || catboxMsg.includes("ENOTFOUND")) {
            throw new Error(`❌ Servicios de subida temporalmente no disponibles. Verifica la conexión.`);
          }
          throw new Error(
            `Todos los servicios fallaron — uguu.se, Catbox y Litterbox. Último: ${litterMsg}`,
          );
        }
      }
    }

    if (this.uploadService === "filegarden") {
      if (!this.hasFileGardenCreds()) {
        log.warn(
          `⚠️ [UPLOAD] UPLOAD_SERVICE=filegarden pero faltan credenciales — usando catbox como primario.`,
        );
      } else {
        log.info(`📤 [UPLOAD] Intentando subir a FileGarden primero (configurado)...`);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            log.info(
              `📤 [FILEGARDEN] Intento ${attempt}/${maxRetries} - Subiendo archivo...`,
            );
            return await this.uploadToFileGarden(filePath);
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            log.error(`❌ [FILEGARDEN] Error en intento ${attempt}:`, errorMsg);

            if (attempt === maxRetries) {
              log.info(
                `🔄 [FALLBACK] FileGarden falló tras ${maxRetries} intentos, probando Catbox...`,
              );
              break;
            }
            if (attempt < maxRetries) {
              const delay = errorMsg.includes("ENOTFOUND")
                ? retryDelay * 2
                : retryDelay;
              log.info(`⏱️ Esperando ${delay}ms antes del siguiente intento...`);
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
        }

        // Cadena de fallback: X02 (si está configurado) → Catbox → Litterbox
        // (filegarden ya falló como primario, no tiene sentido reintentar
        // como último recurso).
        const x02 = await this.tryX02Fallback(filePath);
        if (x02) return x02;
        try {
          const result = await this.uploadToCatboxWithRetry(filePath);
          log.info(`✅ [FALLBACK] Archivo subido exitosamente a Catbox`);
          return result;
        } catch (catboxError) {
          const catboxMsg =
            catboxError instanceof Error ? catboxError.message : String(catboxError);
          log.error(`❌ [FALLBACK] Catbox también falló:`, catboxMsg);
          try {
            const result = await this.uploadToLitterboxFallback(filePath);
            log.info(`✅ [FALLBACK] Archivo subido a Litterbox como último recurso`);
            return result;
          } catch (litterError) {
            const litterMsg =
              litterError instanceof Error ? litterError.message : String(litterError);
            if (litterMsg.includes("ENOTFOUND") || catboxMsg.includes("ENOTFOUND")) {
              throw new Error(`❌ Servicios de subida temporalmente no disponibles. Verifica la conexión.`);
            }
            throw new Error(
              `Todos los servicios fallaron — FileGarden, Catbox y Litterbox. Último: ${litterMsg}`,
            );
          }
        }
      }
    }

    if (this.uploadService === "nullpointer") {
      log.info(`📤 [UPLOAD] Intentando subir a 0x0.st primero (configurado)...`);

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          log.info(`📤 [0x0.ST] Intento ${attempt}/${maxRetries} - Subiendo archivo...`);
          return await this.uploadToNullpointerWithRetry(filePath);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error(`❌ [0x0.ST] Error en intento ${attempt}:`, errorMsg);

          if (errorMsg.includes("getaddrinfo ENOTFOUND") || errorMsg.includes("ENOTFOUND")) {
            log.info(`🌐 [DNS] Problema de conectividad detectado con 0x0.st`);
          }

          if (attempt === maxRetries) {
            log.info(`🔄 [FALLBACK] 0x0.st falló tras ${maxRetries} intentos, probando Catbox...`);
            break;
          }

          if (attempt < maxRetries) {
            const delay = errorMsg.includes("ENOTFOUND") ? retryDelay * 2 : retryDelay;
            log.info(`⏱️ Esperando ${delay}ms antes del siguiente intento...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      // Cadena de fallback: X02 (si está configurado) → Catbox → Litterbox
      const x02 = await this.tryX02Fallback(filePath);
      if (x02) return x02;
      try {
        const result = await this.uploadToCatboxWithRetry(filePath);
        log.info(`✅ [FALLBACK] Archivo subido exitosamente a Catbox`);
        return result;
      } catch (catboxError) {
        const catboxMsg = catboxError instanceof Error ? catboxError.message : String(catboxError);
        log.error(`❌ [FALLBACK] Catbox también falló:`, catboxMsg);
        try {
          const result = await this.uploadToLitterboxFallback(filePath);
          log.info(`✅ [FALLBACK] Archivo subido a Litterbox como último recurso`);
          return result;
        } catch (litterError) {
          const litterMsg = litterError instanceof Error ? litterError.message : String(litterError);
          const fg = await this.tryFileGardenLastResort(filePath);
          if (fg) return fg;
          if (litterMsg.includes("ENOTFOUND") || catboxMsg.includes("ENOTFOUND")) {
            throw new Error(`❌ Servicios de subida temporalmente no disponibles. Verifica la conexión.`);
          }
          throw new Error(`Todos los servicios fallaron — 0x0.st, Catbox y Litterbox. Último: ${litterMsg}`);
        }
      }
    }

    if (this.uploadService === "catbox") {
      log.info(`📤 [UPLOAD] Intentando subir a Catbox primero (configurado)...`);
      
      // Intentar Catbox con reintentos
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          log.info(`📤 [CATBOX] Intento ${attempt}/${maxRetries} - Subiendo archivo...`);
          return await this.uploadToCatboxWithRetry(filePath);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error(`❌ [CATBOX] Error en intento ${attempt}:`, errorMsg);
          
          // Verificar si es un error de conectividad DNS
          if (errorMsg.includes('getaddrinfo ENOTFOUND') || errorMsg.includes('ENOTFOUND')) {
            log.info(`🌐 [DNS] Problema de conectividad detectado con Catbox`);
          }
          
          if (attempt === maxRetries) {
            log.info(`🔄 [FALLBACK] Catbox falló después de ${maxRetries} intentos, intentando con Litterbox como fallback...`);
            break; // Salir para intentar el fallback
          }
          
          // Esperar antes del siguiente intento (más tiempo si es problema DNS)
          if (attempt < maxRetries) {
            const delay = errorMsg.includes('ENOTFOUND') ? retryDelay * 2 : retryDelay;
            log.info(`⏱️ Esperando ${delay}ms antes del siguiente intento...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      // Segunda opción: X02 (si está configurado), después Litterbox
      const x02 = await this.tryX02Fallback(filePath);
      if (x02) return x02;
      try {
        const result = await this.uploadToLitterboxFallback(filePath);
        log.info(`✅ [FALLBACK] Archivo subido exitosamente a Litterbox como fallback`);
        return result;
      } catch (fallbackError) {
        const fallbackErrorMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);

        const fg = await this.tryFileGardenLastResort(filePath);
        if (fg) return fg;

        // Si ambos servicios fallan por problemas de conectividad, dar un mensaje más útil
        if (fallbackErrorMsg.includes('getaddrinfo ENOTFOUND') || fallbackErrorMsg.includes('ENOTFOUND')) {
          log.error(`🌐 [DNS] Problema de conectividad detectado con ambos servicios`);
          throw new Error(`❌ Servicios de subida temporalmente no disponibles. Verifica tu conexión a internet y intenta nuevamente en unos minutos.`);
        }

        throw new Error(`Error en Catbox y Litterbox fallback: ${fallbackErrorMsg}`);
      }
    } else {
      log.info(`📤 [UPLOAD] Intentando subir a Litterbox primero (configurado)...`);
      
      // Intentar Litterbox con reintentos
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          log.info(`📤 [LITTERBOX] Intento ${attempt}/${maxRetries} - Subiendo archivo...`);
          return await this.uploadToLitterbox(filePath);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error(`❌ [LITTERBOX] Error en intento ${attempt}:`, errorMsg);
          
          // Verificar si es un error de conectividad DNS
          if (errorMsg.includes('getaddrinfo ENOTFOUND') || errorMsg.includes('ENOTFOUND')) {
            log.info(`🌐 [DNS] Problema de conectividad detectado con Litterbox`);
          }
          
          if (attempt === maxRetries) {
            log.info(`🔄 [FALLBACK] Litterbox falló después de ${maxRetries} intentos, intentando con Catbox como fallback...`);
            break; // Salir para intentar el fallback
          }
          
          // Esperar antes del siguiente intento (más tiempo si es problema DNS)
          if (attempt < maxRetries) {
            const delay = errorMsg.includes('ENOTFOUND') ? retryDelay * 2 : retryDelay;
            log.info(`⏱️ Esperando ${delay}ms antes del siguiente intento...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      // Segunda opción: X02 (si está configurado), después Catbox
      const x02 = await this.tryX02Fallback(filePath);
      if (x02) return x02;
      try {
        const result = await this.uploadToCatboxWithRetry(filePath);
        log.info(`✅ [FALLBACK] Archivo subido exitosamente a Catbox como fallback`);
        return result;
      } catch (fallbackError) {
        const fallbackErrorMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);

        const fg = await this.tryFileGardenLastResort(filePath);
        if (fg) return fg;

        // Si ambos servicios fallan por problemas de conectividad, dar un mensaje más útil
        if (fallbackErrorMsg.includes('getaddrinfo ENOTFOUND') || fallbackErrorMsg.includes('ENOTFOUND')) {
          log.error(`🌐 [DNS] Problema de conectividad detectado con ambos servicios`);
          throw new Error(`❌ Servicios de subida temporalmente no disponibles. Verifica tu conexión a internet y intenta nuevamente en unos minutos.`);
        }

        throw new Error(`Error en Litterbox y Catbox fallback: ${fallbackErrorMsg}`);
      }
    }
  }

  private async testConnectivity(): Promise<void> {
    try {
      // Test simple con Google DNS (más confiable)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch('https://dns.google/resolve?name=catbox.moe&type=A', {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`DNS test failed: ${response.status}`);
      }

      const result = await response.json();
      
      if (!result.Answer || result.Answer.length === 0) {
        throw new Error('DNS resolution failed');
      }

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('DNS test timeout');
      }
      throw error;
    }
  }

  private async uploadToCatbox(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", fs.createReadStream(filePath));

    const response = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "accept-language": "es-419,es;q=0.9,es-ES;q=0.8,en;q=0.7,en-GB;q=0.6,en-US;q=0.5,es-US;q=0.4",
        "cache-control": "no-cache",
        "priority": "u=1, i",
        "sec-ch-ua": "\"Chromium\";v=\"142\", \"Microsoft Edge\";v=\"142\", \"Not_A Brand\";v=\"99\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-requested-with": "XMLHttpRequest",
        "Referer": "https://catbox.moe/"
      },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Error subiendo a Catbox: ${response.statusText}`);
    }

    const result = await response.text();

    if (!result.startsWith("https://")) {
      throw new Error(`Respuesta inválida de Catbox: ${result}`);
    }

    return result;
  }

  private async uploadToLitterbox(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("time", this.litterboxExpiry);
    form.append("fileToUpload", fs.createReadStream(filePath));

    const response = await fetch(
      "https://litterbox.catbox.moe/resources/internals/api.php",
      {
        method: "POST",
        body: form,
      }
    );

    if (!response.ok) {
      throw new Error(`Error subiendo a Litterbox: ${response.statusText}`);
    }

    const result = await response.text();

    if (!result.startsWith("https://")) {
      throw new Error(`Respuesta inválida de Litterbox: ${result}`);
    }

    return result;
  }

  private async uploadToCatboxWithRetry(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", fs.createReadStream(filePath));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 segundos timeout

    try {
      const response = await fetch("https://catbox.moe/user/api.php", {
        method: "POST",
        headers: {
          "accept": "application/json",
          "accept-language": "es-419,es;q=0.9,es-ES;q=0.8,en;q=0.7,en-GB;q=0.6,en-US;q=0.5,es-US;q=0.4",
          "cache-control": "no-cache",
          "priority": "u=1, i",
          "sec-ch-ua": "\"Chromium\";v=\"142\", \"Microsoft Edge\";v=\"142\", \"Not_A Brand\";v=\"99\"",
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": "\"Windows\"",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "x-requested-with": "XMLHttpRequest",
          "Referer": "https://catbox.moe/"
        },
        body: form,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Error subiendo a Catbox: ${response.statusText}`);
      }

      const result = await response.text();

      if (!result.startsWith("https://")) {
        throw new Error(`Respuesta inválida de Catbox: ${result}`);
      }

      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Timeout al subir archivo a Catbox (30s)');
      }
      throw error;
    }
  }

  /**
   * Whether FileGarden credentials are present. When true, FileGarden is
   * enabled both as a primary option (UPLOAD_SERVICE=filegarden) and as the
   * final fallback after the catbox/litterbox/nullpointer chain.
   */
  private hasFileGardenCreds(): boolean {
    return (
      !!this.configService.get<string>("music.filegardenUserId") &&
      !!this.configService.get<string>("music.filegardenAuthCookie")
    );
  }

  /**
   * Upload a single file to FileGarden using its private "pipe" endpoint.
   * The API expects raw binary in the body, the file name in the X-Data
   * header (URL-encoded JSON), and auth via the session cookie. Returns the
   * public URL.
   */
  private async uploadToFileGarden(filePath: string): Promise<string> {
    const userId = this.configService.get<string>("music.filegardenUserId");
    const authCookie = this.configService.get<string>(
      "music.filegardenAuthCookie",
    );
    if (!userId || !authCookie) {
      throw new Error(
        "FileGarden no configurado (FILEGARDEN_USER_ID o FILEGARDEN_AUTH_COOKIE vacíos)",
      );
    }

    const filename = path.basename(filePath);
    // The FileGarden API decodes X-Data with decodeURI(), NOT
    // decodeURIComponent() — so reserved chars like ':' and ',' must remain
    // unencoded for the resulting JSON to parse. encodeURI() produces exactly
    // that shape (e.g. `%7B%22parent%22:null,%22name%22:%22x.mp3%22%7D`).
    const xData = encodeURI(JSON.stringify({ parent: null, name: filename }));
    // Stream en vez de readFile: el endpoint acepta el binario crudo en el
    // body, así que no hay razón para tener el archivo entero en RAM (el
    // resto de los uploaders ya usaban createReadStream). Se manda
    // Content-Length explícito porque sin él node-fetch cae a
    // Transfer-Encoding: chunked, que este endpoint rechaza.
    const { size } = await fs.promises.stat(filePath);
    const body = fs.createReadStream(filePath);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch(
        `https://api.filegarden.com/users/${encodeURIComponent(userId)}/pipe`,
        {
          method: "POST",
          headers: {
            Cookie: `auth=${authCookie}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(size),
            "X-Data": xData,
            "User-Agent": "chat-bot/1.0",
          },
          body,
          signal: controller.signal,
        },
      );
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(
          `Error subiendo a FileGarden (${response.status}): ${errText || response.statusText}`,
        );
      }

      // Two response shapes seen in the wild:
      //   1. flat object  → `{ id, name, path, ... }`
      //   2. wrapped list → `{ items: [{ path, ... }] }`
      // Single-file uploads return shape (1); the docs/ShareX template
      // referenced shape (2). Accept both so we don't have to track API drift.
      const json = (await response.json()) as {
        path?: string;
        items?: Array<{ path?: string }>;
      };
      const rawPath = json?.path ?? json?.items?.[0]?.path;
      if (!rawPath) {
        throw new Error(
          `Respuesta inválida de FileGarden: ${JSON.stringify(json)}`,
        );
      }
      // Public CDN host is file.garden (the *.com domain is the dashboard /
      // marketing site; embeds use file.garden which has the right CORS/CDN).
      // The public URL uses a separate share ID — falls back to userId when
      // not configured, since some accounts have the same value for both.
      const publicId =
        this.configService.get<string>("music.filegardenPublicId") || userId;
      return `https://file.garden/${publicId}/${rawPath.replace(/^\/+/, "")}`;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Timeout al subir archivo a FileGarden (60s)");
      }
      throw error;
    }
  }

  /**
   * Last-resort fallback: try FileGarden if creds are configured. Returns
   * null when not configured so the caller can decide whether to throw. Logs
   * but never rethrows so it always reports the original chain failure.
   */
  private async tryFileGardenLastResort(filePath: string): Promise<string | null> {
    if (!this.hasFileGardenCreds()) return null;
    try {
      log.info(`📤 [FILEGARDEN] Último recurso — subiendo archivo...`);
      const url = await this.uploadToFileGarden(filePath);
      log.info(`✅ [FILEGARDEN] Subida exitosa: ${url}`);
      return url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`❌ [FILEGARDEN] Falló como último recurso: ${msg}`);
      return null;
    }
  }

  /**
   * Upload a single file to X02 (POST https://up.x02.me/api/upload).
   * Multipart with field `file`, auth via `x-api-key` (the API rejects
   * keyless requests from outside x02.me with 401). No `expiry` is sent, so
   * the file is kept like on catbox. `?format=json` → `data.url`.
   */
  private async uploadToX02(filePath: string): Promise<string> {
    const apiKey = this.configService.get<string>("music.x02ApiKey");
    if (!apiKey) {
      throw new Error("X02 no configurado (X02_API_KEY vacío)");
    }

    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch("https://up.x02.me/api/upload?format=json", {
        method: "POST",
        headers: { "x-api-key": apiKey, "User-Agent": "chat-bot/1.0" },
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const raw = await response.text().catch(() => "");
      let json: { success?: boolean; error?: string; data?: { url?: string } } | null = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }

      if (!response.ok || json?.success === false) {
        throw new Error(
          `Error subiendo a X02 (${response.status}): ${json?.error || raw || response.statusText}`,
        );
      }

      const url = json?.data?.url;
      if (!url || !url.startsWith("https://")) {
        throw new Error(`Respuesta inválida de X02: ${raw.slice(0, 300)}`);
      }
      return url;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Timeout al subir archivo a X02 (60s)");
      }
      throw error;
    }
  }

  /**
   * Second option of every upload chain: try X02 once if the key is set.
   * Returns null (never throws) so the caller continues with the rest of the
   * chain exactly as before when X02 is not configured or fails.
   */
  private async tryX02Fallback(filePath: string): Promise<string | null> {
    if (!this.configService.get<string>("music.x02ApiKey")) return null;
    try {
      log.info(`📤 [X02] Fallback — subiendo archivo...`);
      const url = await this.uploadToX02(filePath);
      log.info(`✅ [X02] Subida exitosa: ${url}`);
      return url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`❌ [X02] Falló como fallback: ${msg}`);
      return null;
    }
  }

  /**
   * Upload a single file to uguu.se. Multipart with field name `files[]`,
   * JSON response with `files[0].url` carrying the public link. uguu is a
   * temporary host (~3h retention) — fine for chat playback.
   */
  private async uploadToUguu(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("files[]", fs.createReadStream(filePath));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45_000);

    try {
      const response = await fetch("https://uguu.se/upload", {
        method: "POST",
        headers: { "User-Agent": "chat-bot/1.0" },
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(
          `Error subiendo a uguu.se (${response.status}): ${errText || response.statusText}`,
        );
      }

      const json = (await response.json()) as {
        success?: boolean;
        files?: Array<{ url?: string }>;
        description?: string;
      };

      if (json?.success === false) {
        throw new Error(`uguu.se rechazó la subida: ${json.description ?? "desconocido"}`);
      }

      const url = json?.files?.[0]?.url;
      if (!url || !url.startsWith("http")) {
        throw new Error(`Respuesta inválida de uguu.se: ${JSON.stringify(json)}`);
      }
      return url;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Timeout al subir archivo a uguu.se (45s)");
      }
      throw error;
    }
  }

  private async uploadToNullpointer(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));

    const response = await fetch("https://0x0.st", {
      method: "POST",
      headers: {
        // 0x0.st rejects requests with no UA or generic library UAs.
        "User-Agent": "chat-bot/1.0 (catbox-fallback)",
      },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Error subiendo a 0x0.st: ${response.statusText}`);
    }

    const result = (await response.text()).trim();

    if (!result.startsWith("https://")) {
      throw new Error(`Respuesta inválida de 0x0.st: ${result}`);
    }

    return result;
  }

  private async uploadToNullpointerWithRetry(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch("https://0x0.st", {
        method: "POST",
        headers: {
          "User-Agent": "chat-bot/1.0 (catbox-fallback)",
        },
        body: form,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Error subiendo a 0x0.st: ${response.statusText}`);
      }

      const result = (await response.text()).trim();

      if (!result.startsWith("https://")) {
        throw new Error(`Respuesta inválida de 0x0.st: ${result}`);
      }

      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Timeout al subir archivo a 0x0.st (30s)");
      }
      throw error;
    }
  }

  private async uploadToLitterboxFallback(filePath: string): Promise<string> {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("time", "72h"); // Fijo en 72h para fallback
    form.append("fileToUpload", fs.createReadStream(filePath));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000); // 45 segundos timeout (más tiempo que Catbox)

    try {
      log.info(`📤 [LITTERBOX-FALLBACK] Subiendo con expiración de 72h...`);
      
      const response = await fetch(
        "https://litterbox.catbox.moe/resources/internals/api.php",
        {
          method: "POST",
          body: form,
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Error subiendo a Litterbox fallback: ${response.statusText}`);
      }

      const result = await response.text();

      if (!result.startsWith("https://")) {
        throw new Error(`Respuesta inválida de Litterbox fallback: ${result}`);
      }

      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Timeout al subir archivo a Litterbox fallback (45s)');
      }
      throw error;
    }
  }
}
