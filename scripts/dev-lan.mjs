/**
 * Startet PicPool so, dass Handys im selben WLAN darauf zugreifen koennen.
 *
 * Gedacht fuer den Geraetetest: ermittelt die LAN-Adresse dieses Rechners,
 * legt bei Bedarf eine .env mit dauerhaftem Schluessel an, startet Server und
 * Worker und zeigt den Upload-Link als QR-Code zum Abscannen.
 *
 *   node scripts/dev-lan.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PICPOOL_PORT ?? 8080);

// ---------------------------------------------------------------------------

function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // ohne DHCP vergeben
      candidates.push({ name, address: a.address });
    }
  }
  // Kabel vor WLAN vor allem anderen - das ist in der Regel das Heimnetz.
  const score = (n) => (/ethernet|lan/i.test(n) ? 0 : /wi-?fi|wlan|wireless/i.test(n) ? 1 : 2);
  candidates.sort((a, b) => score(a.name) - score(b.name));
  return candidates[0] ?? null;
}

function ensureEnv(publicUrl) {
  const envPath = path.join(root, '.env');

  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8');
    const key = /^PICPOOL_SECRET_KEY=(.+)$/m.exec(text)?.[1]?.trim();
    if (key && Buffer.from(key, 'base64').length === 32) {
      return { path: envPath, created: false, secretKey: key };
    }
    throw new Error(
      '.env vorhanden, aber PICPOOL_SECRET_KEY fehlt oder ist ungueltig. ' +
        'Bitte 32 Byte base64 eintragen: openssl rand -base64 32',
    );
  }

  // Der Schluessel muss zwischen Neustarts gleich bleiben, sonst lassen sich
  // die verschluesselt abgelegten Tokens nicht mehr anzeigen.
  const secretKey = crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(
    envPath,
    [
      '# Von scripts/dev-lan.mjs erzeugt - nur fuer die Entwicklung.',
      `PICPOOL_PUBLIC_URL=${publicUrl}`,
      `PICPOOL_SECRET_KEY=${secretKey}`,
      `PICPOOL_DATA_DIR=${path.join(root, 'data').replace(/\\/g, '/')}`,
      `PICPOOL_PORT=${PORT}`,
      'PICPOOL_LOG_LEVEL=info',
      '',
    ].join('\n'),
    'utf8',
  );
  return { path: envPath, created: true, secretKey };
}

function loadEnvFile(envPath) {
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------

const lan = lanAddress();
if (!lan) {
  console.error('Keine LAN-Adresse gefunden. Ist der Rechner im Netzwerk?');
  process.exit(1);
}

const publicUrl = `http://${lan.address}:${PORT}`;
const envInfo = ensureEnv(publicUrl);
const fileEnv = loadEnvFile(envInfo.path);

// Die oeffentliche URL folgt immer der aktuellen LAN-Adresse. Die kann sich
// per DHCP aendern, und ein veralteter Wert in der .env wuerde zu Links
// fuehren, die das Handy nicht erreicht.
const env = {
  ...process.env,
  ...fileEnv,
  PICPOOL_PUBLIC_URL: publicUrl,
  PICPOOL_BIND: '0.0.0.0',
  PICPOOL_PORT: String(PORT),
  // Nur im Entwicklungsbetrieb: Diagnoseseite unter /nettest.
  PICPOOL_NETTEST: 'true',
};

const dataDir = env.PICPOOL_DATA_DIR;

console.log('');
console.log('  PicPool - Start fuer den Geraetetest');
console.log('  ' + '-'.repeat(46));
console.log(`  Adresse   : ${publicUrl}   (${lan.name})`);
console.log(`  Daten     : ${dataDir}`);
console.log(`  .env      : ${envInfo.created ? 'neu angelegt' : 'vorhanden'}`);
console.log('');

// --- Bauen ---
console.log('  Baue …');
const build = spawnSync('npm', ['run', 'build'], { cwd: root, env, shell: true, stdio: 'pipe' });
if (build.status !== 0) {
  console.error('  Build fehlgeschlagen:\n' + build.stderr?.toString().slice(-2000));
  process.exit(1);
}
console.log('  Build fertig.\n');

// --- Testalbum sicherstellen ---
const cli = (args) =>
  spawnSync('node', ['apps/server/dist/cli.js', ...args], { cwd: root, env, shell: false, encoding: 'utf8' });

const list = cli(['album:list']);
const hasTestAlbum = /geraetetest/.test(list.stdout ?? '');

if (!hasTestAlbum) {
  const created = cli(['album:create', 'Geraetetest']);
  process.stdout.write(created.stdout ?? '');
  if (created.status !== 0) {
    console.error(created.stderr);
    process.exit(1);
  }
} else {
  const qr = cli(['qr', 'geraetetest', 'upload']);
  process.stdout.write(qr.stdout ?? '');
}

console.log('  Scanne den QR-Code mit dem Handy (gleiches WLAN!).');
console.log(`  Bei Upload-Problemen: ${publicUrl}/nettest`);
console.log('');
console.log('  Fehlerberichte ansehen:  node apps/server/dist/cli.js fehler');
console.log('  Beenden mit Strg+C.\n');

// --- Server und Worker ---
const procs = [];

function start(name, script) {
  const p = spawn('node', [script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `[${name}]`;
  p.stdout.on('data', (c) => process.stdout.write(prefix(tag, c)));
  p.stderr.on('data', (c) => process.stderr.write(prefix(tag, c)));
  p.on('exit', (code) => console.log(`${tag} beendet (${code})`));
  procs.push(p);
}

function prefix(tag, chunk) {
  return String(chunk)
    .split('\n')
    .filter(Boolean)
    .map((l) => `${tag} ${l}\n`)
    .join('');
}

start('app', 'apps/server/dist/index.js');
start('worker', 'apps/server/dist/worker.js');

const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
