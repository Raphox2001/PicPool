import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Liefert die Upload-Seite aus.
 *
 * Die gebauten Dateien liegen unter apps/upload/dist. Aus dist/routes heraus
 * sind das vier Ebenen nach oben; im Entwicklungsbetrieb mit tsx eine
 * weniger. Beide Faelle werden geprueft, damit der Start nicht davon abhaengt,
 * wie der Prozess gestartet wurde.
 */
function findUploadDist(): string | null {
  const candidates = [
    path.resolve(here, '../../../upload/dist'),      // dist/routes -> apps/upload/dist
    path.resolve(here, '../../../../upload/dist'),   // src/routes  -> apps/upload/dist
    path.resolve(process.cwd(), 'apps/upload/dist'),
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, 'index.html'))) ?? null;
}

export async function registerPageRoutes(app: FastifyInstance): Promise<void> {
  const dist = findUploadDist();

  if (!dist) {
    app.log.error(
      'Upload-Seite nicht gefunden. Wurde "npm run build --workspace apps/upload" ausgefuehrt?',
    );
    return;
  }

  app.log.info({ dist }, 'Upload-Seite gefunden');

  await app.register(fastifyStatic, {
    root: dist,
    prefix: '/upload-assets/',
    // Die Dateinamen tragen einen Inhalts-Hash, sind also unveraenderlich.
    maxAge: '1y',
    immutable: true,
    index: false,
    // Nur die gebauten Dateien ausliefern, kein Verzeichnislisting.
    list: false,
  });

  const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');

  app.get<{ Params: { token: string } }>('/u/:token', async (req, reply) => {
    // Der Token wird hier absichtlich NICHT geprueft. Die Seite laedt und
    // fragt anschliessend selbst nach; so bekommt der Gast eine freundliche
    // Meldung im gewohnten Layout statt einer nackten Fehlerseite.
    void req;
    return reply
      .type('text/html; charset=utf-8')
      // Kein Caching: sonst zeigt ein zurueckkehrender Gast eine veraltete
      // Seite, waehrend die Asset-Namen sich laengst geaendert haben.
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .send(indexHtml);
  });

  // Ein Aufruf ohne Token soll nicht ins Leere laufen.
  app.get('/u', async (_req, reply) =>
    reply.code(404).type('text/plain; charset=utf-8').send('Es fehlt der Teil nach /u/ im Link.'),
  );
}
