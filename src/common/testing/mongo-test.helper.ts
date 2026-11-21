import * as os from 'os';
import { MongooseModule, MongooseModuleOptions } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection } from 'mongoose';

/**
 * Harness de tests contra un Mongo efímero real. El grafo depende de
 * semántica específica de Mongo — upsert sobre índice único, $inc de peso,
 * $graphLookup — que un mock del Model no verificaría. Cada suite levanta su
 * propio servidor y lo apaga en afterAll.
 */
let mongod: MongoMemoryServer | null = null;

export const rootMongooseTestModule = () =>
  MongooseModule.forRootAsync({
    useFactory: async () => {
      mongod = await MongoMemoryServer.create();
      // El driver de mongodb >= 7.8 carga `os` con un `import()` dinámico, que
      // Jest en modo CommonJS no soporta: la carga falla, la metadata del
      // handshake sale sin `driver` y el servidor rechaza la conexión
      // ("Missing required sub-document 'driver'"). Se le pasa `os` a mano.
      // Sólo afecta a los tests: en producción Node resuelve el import solo.
      return { uri: mongod.getUri(), runtimeAdapters: { os } } as MongooseModuleOptions;
    },
  });

export const closeMongoConnection = async (connection?: Connection): Promise<void> => {
  if (connection) await connection.close();
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
};

/**
 * Mongoose construye los índices de forma asíncrona y en background. Sin
 * esperar a que existan, un test de unicidad pasa por accidente porque el
 * índice todavía no está. Llamar SIEMPRE antes de aseverar sobre índices
 * únicos.
 */
export const syncAllIndexes = async (connection: Connection): Promise<void> => {
  await Promise.all(
    Object.values(connection.models).map((model) => model.syncIndexes()),
  );
};
