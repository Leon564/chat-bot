import { cosine } from './embedding.service';

/**
 * Evaluación de umbrales para `npm run calibrate:memory`: con vectores ya
 * calculados, cuenta para cada umbral cuántos recuerdos esperados se traen
 * (aciertos) y cuántos se traen sin que correspondan (falsos positivos).
 * Puro, sin red, para poder testearlo.
 */

export interface CalibrationRow {
  threshold: number;
  hits: number;
  expected: number;
  falsePositives: number;
}

export function evaluateThresholds(
  memories: { id: string; vector: number[] }[],
  messages: { message: string; vector: number[]; expect: string[] }[],
  thresholds: number[],
): CalibrationRow[] {
  const expected = messages.reduce((n, m) => n + m.expect.length, 0);
  // Parecidos calculados una sola vez.
  const scores = messages.map((m) => memories.map((mem) => ({ id: mem.id, score: cosine(m.vector, mem.vector) })));
  return thresholds.map((threshold) => {
    let hits = 0;
    let falsePositives = 0;
    messages.forEach((m, i) => {
      for (const { id, score } of scores[i]) {
        if (score < threshold) continue;
        if (m.expect.includes(id)) hits++;
        else falsePositives++;
      }
    });
    return { threshold, hits, expected, falsePositives };
  });
}

/** El umbral más bajo sin falsos positivos (el que más trae sin traer de más), o null. */
export function recommendThreshold(rows: CalibrationRow[]): CalibrationRow | null {
  const clean = rows.filter((r) => r.falsePositives === 0).sort((a, b) => a.threshold - b.threshold);
  return clean[0] ?? null;
}
