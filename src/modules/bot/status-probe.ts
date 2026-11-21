import fetch from 'node-fetch';

export const PROBE_TIMEOUT_MS = 5000;

export interface ProbeResult {
  name: string;
  ok: boolean;
  /** Milisegundos hasta la respuesta, o null si no respondió. */
  ms: number | null;
  /** Código HTTP, "timeout" o el error de red. */
  detail: string;
}

/**
 * ¿Responde este servicio? Cualquier respuesta HTTP por debajo de 500 cuenta
 * como "responde" (un 404 o un 405 en la raíz de una API es normal): lo que
 * importa para `!estado` es si el host está vivo, no si esa URL existe.
 */
export async function probe(
  name: string,
  url: string,
  doFetch: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ProbeResult> {
  if (!url) return { name, ok: false, ms: null, detail: 'sin configurar' };
  const started = now();
  try {
    const res = await doFetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) as any,
    });
    const ms = now() - started;
    return { name, ok: res.status < 500, ms, detail: String(res.status) };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const timeout = e?.name === 'AbortError' || e?.name === 'TimeoutError';
    return { name, ok: false, ms: null, detail: timeout ? 'timeout' : (e?.message ?? 'error').slice(0, 40) };
  }
}

/** "modelo ✅ 240 ms" / "FileGarden ⚠️ 503" / "catbox ❌ timeout". */
export function formatProbe(r: ProbeResult): string {
  if (r.ok) return `${r.name} ✅ ${r.ms} ms`;
  if (r.ms !== null) return `${r.name} ⚠️ ${r.detail}`;
  return `${r.name} ❌ ${r.detail}`;
}

/** "3 h 12 min", "4 min", "2 d 5 h". */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}
