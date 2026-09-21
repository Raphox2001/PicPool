import { useEffect, useState, useCallback } from 'react';
import {
  api,
  formatBytes,
  formatDate,
  formatDateTime,
  type AlbumSummary,
  type AdminAsset,
  type UploaderInfo,
  type ShareLinkInfo,
} from './api';

interface Detail {
  album: AlbumSummary;
  uploaders: UploaderInfo[];
  assets: AdminAsset[];
}

export function AlbumDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const d = await api.get<Detail & { ok: boolean }>(`/albums/${id}`);
    setData(d);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <div className="loading">Wird geladen …</div>;
  const { album, uploaders, assets } = data;

  async function patch(body: Record<string, unknown>): Promise<void> {
    setError(null);
    try {
      await api.patch(`/albums/${id}`, body);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    }
  }

  async function removeAsset(assetId: string, filename: string): Promise<void> {
    if (!window.confirm(`„${filename}" wirklich löschen? Die Datei wird von der Platte entfernt.`)) {
      return;
    }
    await api.del(`/assets/${assetId}`);
    await load();
  }

  async function deleteAlbum(): Promise<void> {
    setError(null);
    try {
      await api.del(`/albums/${id}`, { confirmName });
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.');
    }
  }

  return (
    <>
      <button className="back" onClick={onBack}>
        ← Alle Alben
      </button>

      <div className="head-row">
        <h1>{album.name}</h1>
        <span className="muted small">
          {album.files} {album.files === 1 ? 'Datei' : 'Dateien'} · {formatBytes(album.bytes)}
        </span>
      </div>

      {error && <p className="error">{error}</p>}

      {/* --- Links --- */}
      <section className="panel">
        <h2>Links</h2>
        <p className="muted small">
          Der Upload-Link geht an die Gäste, der Galerie-Link zum Ansehen. Beide funktionieren ohne
          Anmeldung — wer den Link hat, kommt rein.
        </p>
        <div className="links">
          {album.links.map((l) => (
            <LinkCard key={l.id} link={l} onChanged={() => void load()} />
          ))}
        </div>
        <div className="row-actions">
          <button
            className="btn ghost"
            onClick={async () => {
              await api.post(`/albums/${id}/links`, { kind: 'upload' });
              await load();
            }}
          >
            Weiteren Upload-Link
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              await api.post(`/albums/${id}/links`, { kind: 'gallery' });
              await load();
            }}
          >
            Weiteren Galerie-Link
          </button>
        </div>
      </section>

      {/* --- Einstellungen --- */}
      <section className="panel">
        <h2>Einstellungen</h2>
        <Toggle
          checked={album.settings.allowDownloads}
          onChange={(v) => void patch({ allowDownloads: v })}
          label="Herunterladen erlauben"
          hint="Aus: Bilder sind nur ansehbar, Originale und ZIP werden abgewiesen."
        />
        <Toggle
          checked={album.settings.allowOriginalsOnLan}
          onChange={(v) => void patch({ allowOriginalsOnLan: v })}
          label="Originalauflösung im Heimnetz"
          hint="Gilt auch, wenn Herunterladen aus ist — aber nur für Geräte im konfigurierten Subnetz."
        />
        <Toggle
          checked={album.settings.stripGps}
          onChange={(v) => void patch({ stripGps: v })}
          label="GPS-Daten aus den Vorschaubildern entfernen"
          hint="Betrifft nur die Vorschauen. Die Originale bleiben unverändert."
        />
        <Toggle
          checked={album.archivedAt !== null}
          onChange={(v) => void patch({ archived: v })}
          label="Archiviert"
          hint="Archivierte Alben sind über ihre Links nicht mehr erreichbar."
        />
      </section>

      {/* --- Beitragende --- */}
      {uploaders.length > 0 && (
        <section className="panel">
          <h2>Beigetragen haben</h2>
          <div className="chips">
            {uploaders.map((u) => (
              <span key={u.id} className="chip">
                {u.name} <span className="muted">{u.count}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* --- Inhalt --- */}
      <section className="panel">
        <h2>Inhalt</h2>
        {assets.length === 0 ? (
          <p className="muted">Noch nichts hochgeladen.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Datei</th>
                <th>Von</th>
                <th>Aufgenommen</th>
                <th>Größe</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className="mono small">{a.originalFilename}</span>
                    {a.kind === 'video' && <span className="badge">Video</span>}
                  </td>
                  <td className="small">{a.uploaderName ?? '–'}</td>
                  <td className="small muted">{formatDateTime(a.takenAt)}</td>
                  <td className="small muted">{formatBytes(a.bytes)}</td>
                  <td>
                    <button
                      className="link-btn danger"
                      onClick={() => void removeAsset(a.id, a.originalFilename)}
                    >
                      Löschen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* --- Album löschen --- */}
      <section className="panel danger-zone">
        <h2>Album löschen</h2>
        <p className="muted small">
          Entfernt das Album mit allen {album.files} Dateien unwiderruflich von der Platte. Zur
          Bestätigung den Albumnamen eingeben.
        </p>
        {deleting ? (
          <>
            <input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={album.name}
              autoFocus
            />
            <div className="row-actions">
              <button
                className="btn danger"
                disabled={confirmName !== album.name}
                onClick={() => void deleteAlbum()}
              >
                Endgültig löschen
              </button>
              <button className="btn ghost" onClick={() => setDeleting(false)}>
                Abbrechen
              </button>
            </div>
          </>
        ) : (
          <button className="btn ghost danger" onClick={() => setDeleting(true)}>
            Album löschen …
          </button>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function LinkCard({ link, onChanged }: { link: ShareLinkInfo; onChanged: () => void }) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const isUpload = link.kind === 'upload';
  const title = isUpload ? 'Zum Hochladen' : 'Zum Ansehen';

  async function copy(): Promise<void> {
    if (!link.url) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ohne sicheren Kontext gibt es keine Zwischenablage. Dann bleibt die
      // Adresse zum Markieren stehen - deshalb steht sie ohnehin im Klartext da.
    }
  }

  if (link.revokedAt) {
    return (
      <div className="link-card revoked">
        <div className="link-title">
          {title} <span className="badge">zurückgezogen</span>
        </div>
        <div className="muted small">Seit {formatDate(link.revokedAt)} nicht mehr gültig.</div>
      </div>
    );
  }

  return (
    <div className="link-card">
      <div className="link-title">{title}</div>
      <code className="link-url">{link.url}</code>
      <div className="muted small">
        {link.useCount} Aufrufe
        {link.lastUsedAt ? ` · zuletzt ${formatDateTime(link.lastUsedAt)}` : ''}
      </div>
      <div className="row-actions">
        <button className="btn ghost" onClick={() => void copy()}>
          {copied ? 'Kopiert' : 'Kopieren'}
        </button>
        <button className="btn ghost" onClick={() => setShowQr(!showQr)}>
          QR-Code
        </button>
        <a className="btn ghost" href={`/api/admin/links/${link.id}/qr.png?size=1200`} download>
          Herunterladen
        </a>
        <button
          className="link-btn danger"
          onClick={async () => {
            if (!window.confirm('Diesen Link zurückziehen? Wer ihn hat, kommt danach nicht mehr rein.')) return;
            await api.del(`/links/${link.id}`);
            onChanged();
          }}
        >
          Zurückziehen
        </button>
      </div>
      {showQr && (
        <img className="qr" src={`/api/admin/links/${link.id}/qr.png?size=600`} alt={`QR-Code ${title}`} />
      )}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{label}</strong>
        {hint && <span className="muted small block">{hint}</span>}
      </span>
    </label>
  );
}
