import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Kopiert Nicht-TypeScript-Dateien nach dist.
 *
 * tsc uebersetzt nur .ts und laesst alles andere liegen. Ohne diesen Schritt
 * fehlen die .sql-Migrationen im Build - was lokal mit tsx nie auffaellt, weil
 * dort direkt aus src gelesen wird, und erst im Container beim ersten Start
 * knallt. Als Node-Skript statt als cp/xcopy, damit es unter Windows und Linux
 * gleich laeuft.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const assets = [{ from: 'src/db/migrations', to: 'dist/db/migrations', ext: '.sql' }];

let copied = 0;

for (const asset of assets) {
  const srcDir = path.join(root, asset.from);
  const outDir = path.join(root, asset.to);

  if (!fs.existsSync(srcDir)) {
    throw new Error(`Quellverzeichnis fehlt: ${asset.from}`);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(asset.ext));
  if (files.length === 0) {
    throw new Error(`Keine ${asset.ext}-Dateien in ${asset.from} gefunden`);
  }

  for (const file of files) {
    fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
    copied++;
  }
}

console.log(`copy-assets: ${copied} Datei(en) nach dist kopiert`);
