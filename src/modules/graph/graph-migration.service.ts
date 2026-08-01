import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { GraphService } from './graph.service';
import { Memory, MemoryDocument } from '../../common/schemas/memory.schema';
import {
  GraphMigration,
  GraphMigrationDocument,
} from '../../common/schemas/graph-migration.schema';

const MIGRATION_NAME = 'memory-to-graph';
const MIN_CONTENT_LENGTH = 10;

/**
 * Frases que preceden al objeto de un gusto. El orden importa: se corta por
 * la primera que matchee. Derivadas de los patrones que ya usaba
 * isMemoryWorthSaving en chat.service.ts.
 */
const LIKE_PREFIXES = [
  /\ble gusta[n]?\s+/i,
  /\bes fan de\s+/i,
  /\bsu favorito es\s+/i,
  /\bsu favorita es\s+/i,
  /\bprefiere\s+/i,
  /\brecomend[oó]\s+/i,
  /\b(anime|manga|manhwa|manhua):\s*/i,
];

/**
 * Importa la colección `memories` al grafo. A diferencia de MigrationService
 * —que se guarda renombrando el archivo fuente a .bak— acá la fuente es una
 * colección, así que el centinela vive en `bot_migrations` con índice único
 * sobre `name`.
 *
 * `memories` NO se borra: queda como respaldo, igual que los .bak.
 */
@Injectable()
export class GraphMigrationService implements OnModuleInit {
  private readonly logger = new Logger(GraphMigrationService.name);

  constructor(
    private readonly graph: GraphService,
    @InjectModel(Memory.name) private readonly memoryModel: Model<MemoryDocument>,
    @InjectModel(GraphMigration.name)
    private readonly migrationModel: Model<GraphMigrationDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      // Nunca impedir el arranque del bot por una migración.
      this.logger.error(`Migración al grafo falló: ${(err as Error)?.message}`);
    }
  }

  /** Devuelve null si la migración ya había corrido. */
  async run(): Promise<{ migrated: number; skipped: number } | null> {
    const already = await this.migrationModel.findOne({ name: MIGRATION_NAME }).lean().exec();
    if (already) return null;

    const rows = await this.memoryModel.find().lean().exec();
    this.logger.log(`🧠 Migración al grafo: procesando ${rows.length} memoria(s)...`);
    let migrated = 0;
    let skipped = 0;

    for (const row of rows) {
      const content = (row.content ?? '').trim();
      const owner = (row.user ?? '').trim();

      // Las globales no tienen sujeto: no hay arista que construir.
      if (!owner || content.length < MIN_CONTENT_LENGTH) {
        skipped++;
        continue;
      }

      const object = this.extractObject(content);
      if (!object) {
        skipped++;
        continue;
      }

      const user = await this.graph.upsertNode({ type: 'user', key: owner, label: owner });
      if (!user) {
        skipped++;
        continue;
      }

      // Si el objeto ya existe como obra o género conocido, enlazar contra
      // ese nodo. Si no, cae a `topic` — el cajón de sastre.
      const existing = await this.graph.resolveByAlias(object, ['work', 'genre', 'artist']);
      const target =
        existing ??
        (await this.graph.upsertNode({ type: 'topic', key: object, label: object }));
      if (!target) {
        skipped++;
        continue;
      }

      await this.graph.upsertEdge({
        from: user._id,
        to: target._id,
        type: 'likes',
        source: 'batch',
      });
      migrated++;
    }

    // El centinela se escribe AL FINAL: si algo explota a mitad, la próxima
    // corrida repite entera, y los upsert la hacen idempotente.
    await this.migrationModel.create({
      name: MIGRATION_NAME,
      stats: { migrated, skipped, total: rows.length },
    });

    this.logger.log(`🧠 Migración al grafo: ${migrated} migradas, ${skipped} descartadas`);
    return { migrated, skipped };
  }

  /**
   * Saca el objeto del gusto de una frase en texto plano, solo cuando matchea
   * una de las frases conocidas de LIKE_PREFIXES. La colección `memories`
   * guarda mucho más que gustos (edad, ciudad, profesión, etc. — ver
   * isMemoryWorthSaving en chat.service.ts), así que si ninguna frase
   * matchea no hay forma confiable de saber si el contenido es un gusto: se
   * descarta en vez de forzarlo como `likes` hacia un topic. Una arista mal
   * tipada es peor que una ausente, porque una fase futura la va a leer y
   * presentar como un hecho. `memories` queda intacta como respaldo, así que
   * una extracción mejor puede reintentarse más adelante.
   */
  private extractObject(content: string): string {
    for (const prefix of LIKE_PREFIXES) {
      const match = content.match(prefix);
      if (match && match.index !== undefined) {
        const tail = content.slice(match.index + match[0].length).trim();
        const cleaned = tail.replace(/[.!?]+$/, '').trim();
        if (cleaned.length >= 3) return cleaned;
      }
    }

    return '';
  }
}
