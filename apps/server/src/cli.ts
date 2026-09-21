import QRCode from 'qrcode';
import { getConfig } from './config.js';
import { ensureDataDirs } from './app.js';
import { getDb } from './db/index.js';
import { createAlbum, listAlbums, getAlbumById, getAlbumUsage } from './services/albums.js';
import { createShareLink, listShareLinks, revealToken, buildUrl, revokeShareLink } from './services/shareLinks.js';
import { listUploadersWithCounts } from './services/uploaders.js';
import { queueStats } from './jobs/queue.js';

/**
 * Verwaltung von der Kommandozeile.
 *
 * Die Admin-Oberflaeche kommt in P3. Bis dahin - und danach fuer Notfaelle,
 * etwa wenn das Admin-Passwort verloren ist - laeuft die Verwaltung hierueber.
 * Auf der NAS:
 *   docker exec picpool-app node apps/server/dist/cli.js album:list
 */

function usage(): void {
  console.log(`
PicPool Verwaltung

  album:create <Name> [--datum JJJJ-MM-TT] [--max-dateien N] [--max-gb N]
  album:list
  album:show <Album-ID|Slug>

  link:create <Album-ID|Slug> <upload|gallery> [--label Text]
  link:list <Album-ID|Slug>
  link:revoke <Link-ID>

  qr <Album-ID|Slug> [upload|gallery]   Link als QR-Code im Terminal
  fehler [--anzahl N]                  Gemeldete Upload-Fehler der Geraete

  status
`);
}

function findAlbum(idOrSlug: string) {
  const direct = getAlbumById(idOrSlug);
  if (direct) return direct;
  const bySlug = getDb().prepare('SELECT * FROM albums WHERE slug = ?').get(idOrSlug);
  return (bySlug as ReturnType<typeof getAlbumById>) ?? null;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Zeichnet den Link als QR-Code ins Terminal.
 *
 * Fuer den Gerätetest ist das der bequemste Weg: Handykamera drauf halten,
 * antippen, fertig - statt eine 22-stellige Zeichenfolge abzutippen.
 */
async function printQr(label: string, url: string): Promise<void> {
  console.log(`\n  ${label}`);
  console.log(`  ${url}\n`);
  const qr = await QRCode.toString(url, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
  console.log(
    qr
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') {
    usage();
    return;
  }

  getConfig();
  ensureDataDirs();
  getDb();

  switch (command) {
    case 'album:create': {
      const name = args[0];
      if (!name) throw new Error('Name fehlt.');

      const maxFiles = flag(args, 'max-dateien');
      const maxGb = flag(args, 'max-gb');

      const album = createAlbum({
        name,
        eventDate: flag(args, 'datum') ?? null,
        maxFiles: maxFiles ? Number(maxFiles) : null,
        maxBytes: maxGb ? Math.round(Number(maxGb) * 1024 ** 3) : null,
      });

      // Beide Links gleich mitanlegen - genau dafuer wird ein Album erstellt.
      const upload = createShareLink(album.id, 'upload', { label: 'Standard' });
      const gallery = createShareLink(album.id, 'gallery', { label: 'Standard' });

      console.log(`\nAlbum angelegt: ${album.name}`);
      console.log(`  ID   : ${album.id}`);
      console.log(`  Slug : ${album.slug}`);

      await printQr('Zum Hochladen (diesen scannen):', upload.url);
      console.log(`\n  Zum Ansehen: ${gallery.url}\n`);
      break;
    }

    case 'album:list': {
      const albums = listAlbums();
      if (albums.length === 0) {
        console.log('Noch keine Alben angelegt.');
        break;
      }
      for (const a of albums) {
        const u = getAlbumUsage(a.id);
        console.log(
          `${a.slug.padEnd(28)} ${String(u.files).padStart(5)} Dateien  ${formatBytes(u.bytes).padStart(10)}  ${a.id}`,
        );
      }
      break;
    }

    case 'album:show': {
      const album = findAlbum(args[0] ?? '');
      if (!album) throw new Error('Album nicht gefunden.');

      const usage = getAlbumUsage(album.id);
      console.log(`\n${album.name}`);
      console.log(`  ID      : ${album.id}`);
      console.log(`  Slug    : ${album.slug}`);
      console.log(`  Datum   : ${album.event_date ?? '-'}`);
      console.log(`  Inhalt  : ${usage.files} Dateien, ${formatBytes(usage.bytes)}`);
      console.log(`  Downloads erlaubt: ${album.allow_downloads ? 'ja' : 'nein'}`);
      console.log(`  GPS entfernen    : ${album.strip_gps ? 'ja' : 'nein'}`);

      const people = listUploadersWithCounts(album.id);
      if (people.length > 0) {
        console.log('\n  Beigetragen haben:');
        for (const p of people) console.log(`    ${p.name.padEnd(30)} ${p.count}`);
      }

      console.log('\n  Links:');
      for (const l of listShareLinks(album.id)) {
        const state = l.revoked_at ? 'zurueckgezogen' : 'aktiv';
        console.log(`    [${l.kind.padEnd(7)}] ${state.padEnd(15)} ${buildUrl(l.kind, revealToken(l))}`);
      }
      console.log();
      break;
    }

    case 'link:create': {
      const album = findAlbum(args[0] ?? '');
      if (!album) throw new Error('Album nicht gefunden.');

      const kind = args[1];
      if (kind !== 'upload' && kind !== 'gallery') {
        throw new Error('Art muss upload oder gallery sein.');
      }

      const created = createShareLink(album.id, kind, { label: flag(args, 'label') });
      console.log(`\n${created.url}\n`);
      break;
    }

    case 'link:list': {
      const album = findAlbum(args[0] ?? '');
      if (!album) throw new Error('Album nicht gefunden.');

      for (const l of listShareLinks(album.id)) {
        const state = l.revoked_at ? 'zurueckgezogen' : 'aktiv';
        console.log(`${l.id}  ${l.kind.padEnd(7)} ${state.padEnd(15)} ${buildUrl(l.kind, revealToken(l))}`);
      }
      break;
    }

    case 'qr': {
      const album = findAlbum(args[0] ?? '');
      if (!album) throw new Error('Album nicht gefunden.');

      const kind = args[1] === 'gallery' ? 'gallery' : 'upload';
      const links = listShareLinks(album.id).filter((l) => l.kind === kind && !l.revoked_at);
      const link = links[links.length - 1];
      if (!link) throw new Error(`Kein aktiver ${kind}-Link fuer dieses Album.`);

      await printQr(
        `${album.name} - ${kind === 'upload' ? 'Hochladen' : 'Ansehen'}:`,
        buildUrl(kind, revealToken(link)),
      );
      console.log();
      break;
    }

    case 'link:revoke': {
      const id = args[0];
      if (!id) throw new Error('Link-ID fehlt.');
      revokeShareLink(id);
      console.log('Link zurueckgezogen.');
      break;
    }

    case 'fehler': {
      const limit = Number(flag(args, 'anzahl') ?? 20);
      const rows = getDb()
        .prepare(
          `SELECT at, detail FROM audit_log
            WHERE action = 'upload_failed'
            ORDER BY id DESC LIMIT ?`,
        )
        .all(limit) as Array<{ at: string; detail: string }>;

      if (rows.length === 0) {
        console.log('Keine gemeldeten Upload-Fehler.');
        break;
      }

      console.log(`\n${rows.length} gemeldete Upload-Fehler (neueste zuerst):\n`);
      for (const row of rows) {
        let d: Record<string, unknown> = {};
        try {
          d = JSON.parse(row.detail) as Record<string, unknown>;
        } catch {
          /* unlesbar - dann eben roh */
        }
        const size = typeof d.fileSize === 'number' ? d.fileSize : 0;
        const sent = typeof d.bytesSent === 'number' ? d.bytesSent : 0;
        const pct = size > 0 ? ((sent / size) * 100).toFixed(0) : '?';

        console.log(`  ${row.at.slice(0, 19).replace('T', ' ')}  ${String(d.filename ?? '?')}`);
        console.log(`    ${formatBytes(size)}  ${String(d.fileType ?? '?')}  -  uebertragen ${formatBytes(sent)} (${pct} %), Versuch ${String(d.attempt ?? '?')}`);
        console.log(`    Phase   : ${String(d.phase ?? '?')}${d.httpStatus ? `  HTTP ${String(d.httpStatus)}` : ''}`);
        console.log(`    Meldung : ${String(d.message ?? '?')}`);
        if (d.responseBody) console.log(`    Antwort : ${String(d.responseBody).slice(0, 200)}`);
        if (d.context) console.log(`    Umstände: ${String(d.context)}`);
        if (d.userAgent) console.log(`    Geraet  : ${String(d.userAgent).slice(0, 120)}`);
        console.log();
      }
      break;
    }

    case 'status': {
      const albums = listAlbums();
      const total = albums.reduce(
        (acc, a) => {
          const u = getAlbumUsage(a.id);
          return { files: acc.files + u.files, bytes: acc.bytes + u.bytes };
        },
        { files: 0, bytes: 0 },
      );
      console.log(`Alben    : ${albums.length}`);
      console.log(`Dateien  : ${total.files}`);
      console.log(`Belegung : ${formatBytes(total.bytes)}`);
      console.log(`Jobs     : ${JSON.stringify(queueStats())}`);
      break;
    }

    default:
      console.error(`Unbekannter Befehl: ${command}`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
