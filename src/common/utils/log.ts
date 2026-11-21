import { Logger, LogLevel } from '@nestjs/common';
import { format } from 'util';

export interface Log {
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Logger con contexto que acepta los mismos argumentos que `console.log`.
 *
 * Existe para reemplazar los `console.*` sueltos sin cambiar cada llamada: el
 * `Logger` de Nest NO es un drop-in, porque toma el último argumento de texto
 * como *contexto* (`logger.log('Subido:', url)` imprimiría `[url] Subido:`).
 * Acá se arma el mensaje con `util.format`, igual que `console`, y recién
 * después se pasa a Nest — así respeta los niveles de `LOG_LEVEL`.
 */
export function createLog(context: string): Log {
  const logger = new Logger(context);
  const msg = (args: unknown[]) => format(...args);
  return {
    info: (...args) => logger.log(msg(args)),
    debug: (...args) => logger.debug(msg(args)),
    warn: (...args) => logger.warn(msg(args)),
    error: (...args) => logger.error(msg(args)),
  };
}

/**
 * Niveles activos según `LOG_LEVEL` (default `log`):
 * - `error` → sólo errores
 * - `warn`  → + avisos
 * - `log`   → + información normal (default)
 * - `debug` → + depuración (los `[DEBUG]` de música, prompts, etc.)
 * - `verbose` → todo
 * Un valor desconocido cae al default.
 */
export function logLevelsFromEnv(raw: string | undefined): LogLevel[] {
  const order: LogLevel[] = ['error', 'warn', 'log', 'debug', 'verbose'];
  const wanted = (raw ?? '').trim().toLowerCase() as LogLevel;
  const idx = order.indexOf(wanted);
  return order.slice(0, (idx === -1 ? order.indexOf('log') : idx) + 1);
}
