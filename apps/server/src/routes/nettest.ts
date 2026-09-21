import type { FastifyInstance } from 'fastify';

/**
 * Netzwerk-Diagnose.
 *
 * Beim Geraetetest scheiterten Uploads mit einem reinen Netzwerkfehler
 * (ProgressEvent, keine HTTP-Antwort), waehrend kleine Anfragen weiterliefen.
 * Um Anwendungs- und Netzwerkebene sauber zu trennen, nimmt dieser Endpunkt
 * beliebige Datenmengen entgegen und meldet nur, wie viele Bytes tatsaechlich
 * ankamen - ohne tus, ohne Datenbank, ohne Verarbeitung.
 *
 * Damit laesst sich beantworten: Liegt es an PicPool oder an der Strecke
 * zwischen Handy und Rechner?
 */
export function registerNetTestRoutes(app: FastifyInstance): void {
  // Rohdaten entgegennehmen, ohne dass Fastify sie zu parsen versucht.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 256 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  app.route({
    method: ['POST', 'PATCH', 'PUT'],
    url: '/api/nettest',
    bodyLimit: 256 * 1024 * 1024,
    handler: async (req, reply) => {
      const body = req.body;
      const bytes = Buffer.isBuffer(body) ? body.length : 0;
      const expected = Number(req.headers['x-expected-bytes'] ?? 0);

      app.log.info(
        {
          nettest: {
            methode: req.method,
            empfangen: bytes,
            erwartet: expected || null,
            vollstaendig: expected ? bytes === expected : null,
          },
        },
        'Netzwerktest',
      );

      return reply
        .header('Cache-Control', 'no-store')
        .send({ ok: true, method: req.method, received: bytes, expected: expected || null });
    },
  });

  /** Kleine Seite, die den Test vom Handy aus ausfuehrbar macht. */
  app.get('/nettest', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(NETTEST_PAGE),
  );
}

const NETTEST_PAGE = `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Netzwerktest</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:1rem;background:#f4f5f7;color:#16191d}
 h1{font-size:1.3rem}
 button{display:block;width:100%;padding:1rem;font-size:1.1rem;font-weight:600;color:#fff;
   background:#1f6feb;border:0;border-radius:10px;margin:.5rem 0;font-family:inherit}
 button:disabled{opacity:.5}
 pre{background:#fff;border:1px solid #d9dde4;border-radius:8px;padding:.7rem;
   font-size:.8rem;white-space:pre-wrap;word-break:break-word;max-height:60vh;overflow:auto}
 .ok{color:#17803d}.err{color:#b42318}
</style></head><body>
<h1>Netzwerktest</h1>
<p>Prüft, ob große Datenmengen vom Handy zum Server durchkommen — ohne PicPool dazwischen.</p>
<button id="seq">Test 1: nacheinander (1, 2, 4, 8, 16 MB)</button>
<button id="par">Test 2: drei gleichzeitig (je 6 MB)</button>
<button id="burst">Test 3: zehn nacheinander (je 4 MB)</button>
<pre id="out">Bereit.</pre>
<script>
const out = document.getElementById('out');
function log(s, cls){ out.innerHTML += '\\n' + (cls ? '<span class="'+cls+'">'+s+'</span>' : s); out.scrollTop = out.scrollHeight; }

function send(mb, tag){
  const bytes = Math.round(mb * 1024 * 1024);
  const body = new Uint8Array(bytes);
  const t0 = performance.now();
  return fetch('/api/nettest', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Expected-Bytes': String(bytes) },
    body
  }).then(async r => {
    const j = await r.json();
    const ms = performance.now() - t0;
    const ok = j.received === bytes;
    log('  ' + tag + ' ' + mb + ' MB -> ' + (ok ? 'ok' : 'NUR ' + j.received + ' B!') +
        '  ' + ms.toFixed(0) + ' ms  (' + (bytes/1024/1024/(ms/1000)).toFixed(1) + ' MB/s)', ok ? 'ok' : 'err');
    return ok;
  }).catch(e => {
    log('  ' + tag + ' ' + mb + ' MB -> FEHLER: ' + e.name + ': ' + e.message, 'err');
    return false;
  });
}

document.getElementById('seq').onclick = async (e) => {
  e.target.disabled = true; out.textContent = 'Test 1: nacheinander';
  for (const mb of [1,2,4,8,16]) await send(mb, 'einzeln');
  log('fertig.'); e.target.disabled = false;
};
document.getElementById('par').onclick = async (e) => {
  e.target.disabled = true; out.textContent = 'Test 2: drei gleichzeitig';
  await Promise.all([send(6,'parallel-a'), send(6,'parallel-b'), send(6,'parallel-c')]);
  log('fertig.'); e.target.disabled = false;
};
document.getElementById('burst').onclick = async (e) => {
  e.target.disabled = true; out.textContent = 'Test 3: zehn nacheinander';
  for (let i=1;i<=10;i++) await send(4, 'nr'+i);
  log('fertig.'); e.target.disabled = false;
};
</script></body></html>`;
