/**
 * Calibra el umbral de parecido de la memoria a largo plazo para una fuente de
 * embeddings, con el set de test/fixtures/memory-recall.json.
 *
 *   npm run calibrate:memory -- --source external   (usa EMBEDDINGS_* del entorno/.env)
 *   npm run calibrate:memory -- --source local      (baja el modelo local la primera vez)
 *
 * No se conecta a Mongo ni al chat: sólo pide vectores e imprime una tabla y
 * el umbral recomendado (el más bajo sin falsos positivos). Poné el resultado
 * en EMBEDDINGS_THRESHOLD_EXTERNAL / EMBEDDINGS_THRESHOLD_LOCAL.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import configuration from '../src/config/configuration';
import { EmbeddingService } from '../src/modules/memory/embedding.service';
import { TransformersLocalEmbedder } from '../src/modules/memory/local-embedder';
import { evaluateThresholds, recommendThreshold } from '../src/modules/memory/calibration';

interface Fixture {
  memories: { id: string; text: string }[];
  messages: { message: string; expect: string[] }[];
}

async function main(): Promise<void> {
  const sourceArg = process.argv.indexOf('--source');
  const source = sourceArg >= 0 ? process.argv[sourceArg + 1] : 'external';
  if (source !== 'external' && source !== 'local') {
    throw new Error('Uso: npm run calibrate:memory -- --source external|local');
  }

  const conf = configuration();
  // Para "local" se borra la key: EmbeddingService va directo al modelo local.
  if (source === 'local') conf.memory.embeddings.apiKey = '';
  else if (!conf.memory.embeddings.apiKey) throw new Error('Falta EMBEDDINGS_API_KEY para calibrar la fuente externa.');
  const config = new ConfigService(conf);
  const embeddings = new EmbeddingService(config, new TransformersLocalEmbedder(config));

  const fixture: Fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'memory-recall.json'), 'utf8'),
  );

  const passages = await embeddings.embed(fixture.memories.map((m) => m.text), 'passage');
  const queries = await embeddings.embed(fixture.messages.map((m) => m.message), 'query');
  if (!passages || !queries) throw new Error('No se pudieron calcular los vectores (mirá los avisos de arriba).');
  if (passages.model !== queries.model) throw new Error('Los vectores salieron de modelos distintos; reintentá.');

  const thresholds = Array.from({ length: 66 }, (_, i) => Math.round((0.3 + i * 0.01) * 100) / 100);
  const rows = evaluateThresholds(
    fixture.memories.map((m, i) => ({ id: m.id, vector: passages.vectors[i] })),
    fixture.messages.map((m, i) => ({ ...m, vector: queries.vectors[i] })),
    thresholds,
  );

  console.log(`Modelo: ${passages.model}`);
  console.log('umbral  aciertos  falsos+');
  for (const r of rows) {
    console.log(`${r.threshold.toFixed(2)}    ${String(r.hits).padStart(2)}/${r.expected}     ${r.falsePositives}`);
  }
  const best = recommendThreshold(rows);
  const envVar = source === 'local' ? 'EMBEDDINGS_THRESHOLD_LOCAL' : 'EMBEDDINGS_THRESHOLD_EXTERNAL';
  console.log(
    best
      ? `\nRecomendado: ${envVar}=${best.threshold} (${best.hits}/${best.expected} aciertos, 0 falsos positivos)`
      : '\nNingún umbral entre 0.30 y 0.95 queda sin falsos positivos: revisá el set o el modelo.',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
