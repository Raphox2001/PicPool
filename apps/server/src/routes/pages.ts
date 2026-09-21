import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Liefert die beiden Gastseiten aus: Upload und Galerie.
 *
 * Die gebauten Dateien liegen unter apps/<name>/dist. Aus dist/routes heraus
 * sind das vier Ebenen nach oben, im Entwicklungsbetrieb mit tsx eine
 * weniger. Beide Faelle werden geprueft, damit der Start nicht davon abhaengt,
 * wie der Prozess gestartet wurde.
 */
function findDist(appName: string): string | null {
  const candidates = [
    path.resolve(here, `../../../${appName}/dist`),
    path.resolve(here, `../../../../${appName}/dist`),
    path.resolve(process.cwd(), `apps/${appName}/dist`),
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, 'index.html'))) ?? null;
}

interface PageApp {
  /** Verzeichnisname unter apps/ */
  name: string;
  /** Pfadpraefix der Gastseite, z.B. /u/ */
  route: string;
  /** Praefix, unter dem die gebauten Dateien liegen */
  assetPrefix: string;
  hint: string;
}

const PAGES: PageApp[] = [
  { name: 'upload', route: '/u/:token', assetPrefix: '/upload-assets/', hint: 'Upload-Seite' },
  { name: 'gallery', route: '/g/:token', assetPrefix: '/gallery-assets/', hint: 'Galerie' },
  { name: 'admin', route: '/admin', assetPrefix: '/admin-assets/', hint: 'Verwaltung' },
];

export async function registerPageRoutes(app: FastifyInstance): Promise<void> {
  let first = true;

  for (const page of PAGES) {
    const dist = findDist(page.name);

    if (!dist) {
      app.log.error(
        `${page.hint} nicht gefunden. Wurde "npm run build --workspace apps/${page.name}" ausgefuehrt?`,
      );
      continue;
    }

    await app.register(fastifyStatic, {
      root: dist,
      prefix: page.assetPrefix,
      // Die Dateinamen tragen einen Inhalts-Hash, sind also unveraenderlich.
      maxAge: '1y',
      immutable: true,
      index: false,
      list: false,
      // reply.sendFile darf nur einmal angelegt werden.
      decorateReply: first,
    });
    first = false;

    const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');

    app.get(page.route, async (_req, reply) =>
      // Das Token wird hier absichtlich NICHT geprueft. Die Seite laedt und
      // fragt anschliessend selbst nach; so bekommt der Gast eine freundliche
      // Meldung im gewohnten Layout statt einer nackten Fehlerseite.
      reply
        .type('text/html; charset=utf-8')
        // Kein Caching: sonst zeigt ein zurueckkehrender Gast eine veraltete
        // Seite, waehrend die Asset-Namen sich laengst geaendert haben.
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .send(indexHtml),
    );

    app.log.info({ dist }, `${page.hint} gefunden`);
  }

  // Aufrufe ohne Token sollen nicht ins Leere laufen.
  for (const p of ['/u', '/g']) {
    app.get(p, async (_req, reply) =>
      reply.code(404).type('text/plain; charset=utf-8').send('Es fehlt der Teil nach dem Schraegstrich im Link.'),
    );
  }
}
