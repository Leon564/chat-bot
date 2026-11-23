import { evaluateThresholds, recommendThreshold } from './calibration';

// Dos recuerdos y tres mensajes con vectores 2D elegidos a mano.
const memories = [
  { id: 'examen', vector: [1, 0] },
  { id: 'gato', vector: [0, 1] },
];
const messages = [
  { message: 'cómo va la facu', vector: [0.9, 0.1], expect: ['examen'] }, // examen ≈ 0.99, gato ≈ 0.11
  { message: 'tu michi', vector: [0.3, 1], expect: ['gato'] }, //          examen ≈ 0.29, gato ≈ 0.96
  { message: 'qué música', vector: [0.6, 0.6], expect: [] }, //            los dos ≈ 0.71
];

describe('calibración de la memoria', () => {
  it('cuenta aciertos y falsos positivos por umbral', () => {
    const rows = evaluateThresholds(memories, messages, [0.5, 0.8]);
    expect(rows).toEqual([
      // 0.5: trae los dos esperados, pero "qué música" trae 2 de más y "tu michi" no trae examen (0.29).
      { threshold: 0.5, hits: 2, expected: 2, falsePositives: 2 },
      // 0.8: los dos esperados y nada de más.
      { threshold: 0.8, hits: 2, expected: 2, falsePositives: 0 },
    ]);
  });

  it('recomienda el umbral más bajo sin falsos positivos', () => {
    const rows = evaluateThresholds(memories, messages, [0.5, 0.7, 0.75, 0.8, 0.99]);
    expect(recommendThreshold(rows)).toEqual({ threshold: 0.75, hits: 2, expected: 2, falsePositives: 0 });
  });

  it('si ningún umbral queda limpio no recomienda nada', () => {
    expect(recommendThreshold([{ threshold: 0.5, hits: 1, expected: 1, falsePositives: 1 }])).toBeNull();
  });
});
