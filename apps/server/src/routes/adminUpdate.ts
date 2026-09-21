import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, nowIso } from '../db/index.js';
import { pseudonymizeIp } from '../lib/crypto.js';
import { requireAdmin } from './adminAuth.js';
import { requestUpdate, readUpdateRequest, clearUpdateRequest } from '../services/maintenance.js';

/**
 * Aktualisierung aus dem Panel heraus.
 *
 * Der Container kann sich NICHT selbst aktualisieren. Dafuer braeuchte er
 * Zugriff auf den Docker-Socket, und der ist gleichbedeutend mit Root auf der
 * gesamten NAS - womit die ganze Kapselung hinfaellig waere (Worker ohne
 * Netzwerk, cap_drop ALL, schreibgeschuetztes Dateisystem, ein Mount).
 *
 * Stattdessen schreibt das Panel nur eine Markierungsdatei ins
 * Datenverzeichnis. Eine DSM-Aufgabe, die einmalig eingerichtet wird, prueft
 * darauf und fuehrt Pull und Neustart aus. Der privilegierte Teil liegt damit
 * in DSM, wo er hingehoert, und bleibt unter deiner Kontrolle.
 */

const RELEASES_URL = 'https://api.github.com/repos/Raphox2001/PicPool/releases/latest';
const CHECK_TIMEOUT_MS = 8000;

/** Liest die eigene Version aus der package.json neben dem Build. */
function currentVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [
    path.resolve(here, '../../package.json'),
    path.resolve(here, '../../../package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string; name?: string };
      if (j.version) return j.version;
    } catch {
      /* naechster Kandidat */
    }
  }
  return 'unbekannt';
}

interface GithubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  body?: string;
}

/** Vergleicht zwei Versionen der Form x.y.z. */
function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);

  const a = parse(candidate);
  const b = parse(current);

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export function registerAdminUpdateRoutes(app: FastifyInstance): void {
  const guard = { preHandler: requireAdmin };

  app.get<{ Querystring: { check?: string } }>('/api/admin/update', guard, async (req) => {
    const version = currentVersion();
    const pending = readUpdateRequest();

    // Die Abfrage bei GitHub geschieht nur auf ausdrueckliche Anforderung.
    // Automatisch im Hintergrund zu fragen wuerde die Adresse der NAS bei
    // jedem Panelaufruf an einen Dritten melden - das gehoert nicht zum
    // stillschweigenden Umfang.
    if (req.query.check !== '1') {
      return { ok: true, version, pending, latest: null };
    }

    try {
      const res = await fetch(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PicPool' },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });

      if (!res.ok) {
        return { ok: true, version, pending, latest: null, checkError: `GitHub antwortete mit ${res.status}` };
      }

      const rel = (await res.json()) as GithubRelease;
      const tag = rel.tag_name ?? rel.name ?? null;

      return {
        ok: true,
        version,
        pending,
        latest: tag
          ? {
              version: tag.replace(/^v/, ''),
              url: rel.html_url ?? null,
              publishedAt: rel.published_at ?? null,
              // Nur der Anfang der Beschreibung; der Rest steht auf GitHub.
              notes: (rel.body ?? '').slice(0, 2000),
              newer: isNewer(tag, version),
            }
          : null,
      };
    } catch (err) {
      app.log.warn({ err }, 'Versionspruefung fehlgeschlagen');
      return {
        ok: true,
        version,
        pending,
        latest: null,
        checkError: 'GitHub war nicht erreichbar.',
      };
    }
  });

  app.post<{ Body: { targetVersion?: string } }>('/api/admin/update', guard, async (req) => {
    const user = req.adminUser!;
    requestUpdate(user.username, req.body?.targetVersion ?? null);

    getDb()
      .prepare(
        `INSERT INTO audit_log (at, actor, action, target_type, target_id, ip, detail)
         VALUES (?, ?, 'update_requested', NULL, NULL, ?, ?)`,
      )
      .run(nowIso(), user.username, pseudonymizeIp(req.ip), JSON.stringify(req.body ?? {}));

    app.log.warn({ user: user.username }, 'Aktualisierung angefordert');
    return { ok: true, pending: readUpdateRequest() };
  });

  app.delete('/api/admin/update', guard, async (req) => {
    clearUpdateRequest();
    app.log.info({ user: req.adminUser?.username }, 'Aktualisierungsanforderung zurueckgenommen');
    return { ok: true };
  });
}
