/**
 * End-to-End-Pruefung des Upload-Wegs.
 *
 * Spricht das tus-Protokoll direkt ueber HTTP, ohne Client-Bibliothek - so
 * wird wirklich der Server geprueft und nicht das Zusammenspiel zweier
 * Bibliotheken, die sich moeglicherweise gegenseitig kaschieren.
 *
 * Aufruf:
 *   node scripts/e2e-upload.mjs <basis-url> <upload-token> <datei> [weitere...]
 */

import fs from 'node:fs';
import path from 'node:path';

const [baseUrl, token, ...files] = process.argv.slice(2);

if (!baseUrl || !token || files.length === 0) {
  console.error('Aufruf: node scripts/e2e-upload.mjs <basis-url> <token> <datei>...');
  process.exit(1);
}

const TUS = { 'Tus-Resumable': '1.0.0' };

function encodeMetadata(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k} ${Buffer.from(String(v), 'utf8').toString('base64')}`)
    .join(',');
}

/** Legt den Upload an und liefert die Ziel-URL. */
async function createUpload(file, size, uploaderName) {
  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: {
      ...TUS,
      'Upload-Length': String(size),
      'Upload-Metadata': encodeMetadata({
        filename: path.basename(file),
        token,
        uploaderName,
      }),
    },
  });

  if (res.status !== 201) {
    throw new Error(`POST ergab ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const location = res.headers.get('location');
  if (!location) throw new Error('Location-Header fehlt');
  return location.startsWith('http') ? location : `${baseUrl}${location}`;
}

/**
 * Uebertraegt die Datei in Abschnitten.
 *
 * Bewusst in mehreren PATCHes, auch wenn die Datei klein ist: genau das ist
 * der Weg, den ein Handy bei einem grossen Video nimmt, und nur so wird die
 * Offset-Verwaltung des Servers tatsaechlich geprueft.
 */
async function sendChunks(url, file, size, chunkSize) {
  const fd = fs.openSync(file, 'r');
  let offset = 0;
  let requests = 0;

  try {
    while (offset < size) {
      const len = Math.min(chunkSize, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);

      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          ...TUS,
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        },
        body: buf,
      });
      requests++;

      if (res.status === 200) {
        // Unser onUploadFinish antwortet mit JSON statt des sonst ueblichen 204.
        const body = await res.json();
        return { body, requests };
      }
      if (res.status !== 204) {
        throw new Error(`PATCH ergab ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      const next = Number(res.headers.get('upload-offset'));
      if (!Number.isFinite(next) || next <= offset) {
        throw new Error(`Server meldete keinen Fortschritt: ${offset} -> ${next}`);
      }
      offset = next;
    }
  } finally {
    fs.closeSync(fd);
  }

  return { body: null, requests };
}

/** Fragt den Offset ab, wie es ein Client nach einer Unterbrechung tut. */
async function headOffset(url) {
  const res = await fetch(url, { method: 'HEAD', headers: TUS });
  if (!res.ok && res.status !== 200 && res.status !== 204) {
    throw new Error(`HEAD ergab ${res.status}`);
  }
  return Number(res.headers.get('upload-offset'));
}

async function uploadFile(file, uploaderName, { resumeTest = false } = {}) {
  const size = fs.statSync(file).size;
  const chunkSize = Math.max(64 * 1024, Math.ceil(size / 4));

  const url = await createUpload(file, size, uploaderName);

  // Die Unterbrechung laesst sich nur pruefen, wenn die Datei ueberhaupt aus
  // mehreren Abschnitten besteht. Bei einer kleinen Datei waere sie nach dem
  // ersten PATCH fertig, und ein anschliessendes HEAD liefe ins Leere.
  if (resumeTest && size > chunkSize) {
    // Nur den ersten Abschnitt senden, dann so tun, als waere die Verbindung
    // abgerissen, den Offset neu erfragen und von dort weitermachen.
    const fd = fs.openSync(file, 'r');
    const first = Buffer.alloc(chunkSize);
    fs.readSync(fd, first, 0, first.length, 0);
    fs.closeSync(fd);

    const res = await fetch(url, {
      method: 'PATCH',
      headers: { ...TUS, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' },
      body: first,
    });
    if (res.status === 200) {
      return { body: await res.json(), requests: 1, size };
    }
    if (res.status !== 204) {
      throw new Error(`Erster Abschnitt ergab ${res.status}`);
    }

    const offset = await headOffset(url);
    if (offset !== first.length) {
      throw new Error(`Offset nach Unterbrechung falsch: ${offset} statt ${first.length}`);
    }

    // Ab hier wie ein wiederaufgenommener Upload.
    const rest = await sendChunksFrom(url, file, size, offset, chunkSize);
    return { ...rest, resumedAt: offset, size };
  }

  const r = await sendChunks(url, file, size, chunkSize);
  return { ...r, size };
}

async function sendChunksFrom(url, file, size, startOffset, chunkSize) {
  const fd = fs.openSync(file, 'r');
  let offset = startOffset;
  let requests = 0;
  try {
    while (offset < size) {
      const len = Math.min(chunkSize, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);

      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          ...TUS,
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        },
        body: buf,
      });
      requests++;

      if (res.status === 200) return { body: await res.json(), requests };
      if (res.status !== 204) {
        throw new Error(`PATCH ergab ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      offset = Number(res.headers.get('upload-offset'));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { body: null, requests };
}

// ---------------------------------------------------------------------------

const results = [];

for (const [i, file] of files.entries()) {
  const name = i === 0 ? 'Oma Erika' : 'Max Mustermann';
  const resumeTest = i === 0;

  process.stdout.write(`  ${path.basename(file).padEnd(28)} als "${name}"${resumeTest ? ' (mit Unterbrechung)' : ''} ... `);
  try {
    const r = await uploadFile(file, name, { resumeTest });
    console.log(
      `ok  ${(r.size / 1024).toFixed(0)} KB in ${r.requests} PATCH${r.requests === 1 ? '' : 'es'}` +
        (r.resumedAt ? `, fortgesetzt ab ${r.resumedAt}` : '') +
        (r.body?.duplicate ? '  [Duplikat erkannt]' : ''),
    );
    results.push({ file, ...r.body });
  } catch (err) {
    console.log(`FEHLER: ${err.message}`);
    results.push({ file, error: err.message });
  }
}

console.log('\nErgebnis:');
console.log(JSON.stringify(results, null, 2));

const failed = results.filter((r) => r.error).length;
process.exit(failed > 0 ? 1 : 0);
