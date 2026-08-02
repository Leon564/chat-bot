import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { GraphService } from './graph.service';
import { GraphNode, GraphNodeDocument } from '../../common/schemas/graph-node.schema';
import {
  GraphMigration,
  GraphMigrationDocument,
} from '../../common/schemas/graph-migration.schema';

const MIGRATION_NAME = 'user-key-identity-v2';

/**
 * Re-clava los nodos `type: 'user'` ya existentes a la nueva regla de
 * identidad (`GraphService.normalizeUserKey`), que a diferencia de la vieja
 * (`normalizeKey`, usada para TODO tipo de nodo hasta esta ronda de
 * correcciones) ya no quita acentos ni colapsa espacios internos — ver el
 * comentario de `normalizeUserKey` para el porqué. Sigue el mismo patrón que
 * `GraphMigrationService`: centinela en `bot_migrations` con índice único
 * sobre `name`, para que no re-corra.
 *
 * Re-clavar se hace a partir de `label` (no de `key`): `label` conserva la
 * capitalización y los acentos originales del username tal como se lo pasó
 * cada llamador (`GraphIngestService.touchUser`, `ingestSocial`,
 * `GraphMigrationService`), mientras que `key` ya viene destruido por la
 * normalización vieja — no hay forma de recuperar acentos perdidos desde ahí.
 *
 * OJO CON LAS FUSIONES YA OCURRIDAS: si dos cuentas ya colapsaron en un mismo
 * nodo `user` bajo la key vieja (por diferir sólo en acentos o en cuántos
 * espacios internos tenían), sus datos (aristas `likes`, `asked_about`,
 * `interacts_with`, etc.) ya están mezclados ahí desde antes de que esta
 * migración corra. Esta migración NO PUEDE separar esos datos — no hay forma
 * de saber, mirando una arista ya fusionada, a cuál de las dos cuentas
 * originales pertenecía. Sólo evita que la colisión se repita HACIA
 * ADELANTE: a partir de acá, "José" y "Jose" (o "Nico Bot" y "Nico  Bot")
 * resuelven a nodos distintos en cualquier ingesta o comando nuevo.
 *
 * Re-clavar puede, a su vez, producir una colisión NUEVA si dos nodos `user`
 * YA EXISTENTES —que antes tenían keys viejas distintas— normalizan a la
 * MISMA key bajo la regla nueva. El índice único {type, key} rechaza ese
 * segundo `update` con E11000; esta migración atrapa el error POR NODO, lo
 * loguea y CONTINÚA con el resto — nunca aborta el arranque del bot por una
 * colisión. El nodo que colisiona se deja con su key vieja (sin re-clavar) y
 * el total de colisiones encontradas queda anotado en el centinela para
 * poder auditarlas después.
 */
@Injectable()
export class GraphUserKeyMigrationService implements OnModuleInit {
  private readonly logger = new Logger(GraphUserKeyMigrationService.name);

  constructor(
    private readonly graph: GraphService,
    @InjectModel(GraphNode.name) private readonly nodeModel: Model<GraphNodeDocument>,
    @InjectModel(GraphMigration.name)
    private readonly migrationModel: Model<GraphMigrationDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      // Nunca impedir el arranque del bot por una migración.
      this.logger.error(`Migración de identidad de usuario falló: ${(err as Error)?.message}`);
    }
  }

  /** Devuelve null si la migración ya había corrido. */
  async run(): Promise<{ rekeyed: number; skipped: number; collisions: number } | null> {
    const already = await this.migrationModel.findOne({ name: MIGRATION_NAME }).lean().exec();
    if (already) return null;

    const users = await this.nodeModel.find({ type: 'user' }).exec();
    this.logger.log(`🔑 Migración de identidad de usuario: revisando ${users.length} nodo(s)...`);

    let rekeyed = 0;
    let skipped = 0;
    let collisions = 0;

    for (const user of users) {
      const newKey = this.graph.normalizeUserKey(user.label || user.key);
      if (!newKey || newKey === user.key) {
        skipped++;
        continue;
      }

      try {
        await this.nodeModel.updateOne({ _id: user._id }, { $set: { key: newKey } }).exec();
        rekeyed++;
      } catch (err) {
        // E11000 (índice único {type, key}): ya existe otro nodo `user` con
        // esta key nueva. Ver el comentario de la clase — se deja este nodo
        // con su key vieja y se sigue con el resto, nunca se aborta.
        collisions++;
        this.logger.warn(
          `No se pudo re-clavar el nodo user "${user.key}" -> "${newKey}": ya existe otro nodo con esa key (E11000 esperado). Se deja sin cambios.`,
        );
        void err;
      }
    }

    // El centinela se escribe AL FINAL: si algo explota a mitad, la próxima
    // corrida repite entera, y re-clavar es idempotente (un nodo ya
    // re-clavado tiene `newKey === user.key` y se salta).
    await this.migrationModel.create({
      name: MIGRATION_NAME,
      stats: { rekeyed, skipped, collisions, total: users.length },
    });

    this.logger.log(
      `🔑 Migración de identidad de usuario: ${rekeyed} re-clavado(s), ${skipped} sin cambios, ${collisions} colisión(es) — ver comentario de la clase sobre por qué no se auto-resuelven`,
    );
    return { rekeyed, skipped, collisions };
  }
}
