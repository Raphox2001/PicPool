import { getConfig } from './config.js';
import { buildApp, ensureDataDirs } from './app.js';
import { closeDb } from './db/index.js';

async function main(): Promise<void> {
  const cfg = getConfig();

  ensureDataDirs();

  const app = await buildApp();

  // Aufraeumen bei Container-Stop. Ohne das bleiben WAL-Dateien und offene
  // Verbindungen zurueck, was beim naechsten Start unnoetige Recovery kostet.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Fahre herunter');
    try {
      await app.close();
      closeDb();
    } catch (err) {
      app.log.error({ err }, 'Fehler beim Herunterfahren');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: cfg.port, host: cfg.bind });
  app.log.info({ publicUrl: cfg.publicUrl, dataDir: cfg.paths.root }, 'PicPool bereit');
}

main().catch((err: unknown) => {
  // Konfigurationsfehler landen hier. Ohne Logger ausgeben, weil der Logger
  // ohne gueltige Konfiguration selbst nicht existiert.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
