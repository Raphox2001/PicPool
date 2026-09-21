import { useEffect, useState, useCallback } from 'react';
import {
  api,
  setCsrfToken,
  formatBytes,
  formatDate,
  type AdminState,
  type AlbumSummary,
  type Overview,
} from './api';
import { Login } from './Login';
import { AlbumDetail } from './AlbumDetail';
import { Account } from './Account';

type View = { name: 'albums' } | { name: 'album'; id: string } | { name: 'account' };

export function App() {
  const [state, setState] = useState<AdminState | null>(null);
  const [view, setView] = useState<View>({ name: 'albums' });

  const loadState = useCallback(async () => {
    const s = await api.get<AdminState & { ok: boolean }>('/state');
    setCsrfToken(s.csrfToken);
    setState(s);
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  if (!state) return <div className="loading">Wird geladen …</div>;

  if (!state.loggedIn) {
    return <Login state={state} onDone={() => void loadState()} />;
  }

  async function logout(): Promise<void> {
    try {
      await api.post('/logout');
    } finally {
      setCsrfToken(null);
      await loadState();
    }
  }

  return (
    <div className="shell">
      <header className="bar">
        <div className="bar-inner">
          <button className="brand" onClick={() => setView({ name: 'albums' })}>
            PicPool
          </button>
          <nav>
            <button
              className={view.name === 'albums' || view.name === 'album' ? 'tab on' : 'tab'}
              onClick={() => setView({ name: 'albums' })}
            >
              Alben
            </button>
            <button
              className={view.name === 'account' ? 'tab on' : 'tab'}
              onClick={() => setView({ name: 'account' })}
            >
              Konto
              {/* Ohne zweiten Faktor ist das Konto die schwaechste Stelle -
                  der Hinweis bleibt sichtbar, bis er eingerichtet ist. */}
              {!state.user?.totpEnabled && <span className="dot" title="Zweiter Faktor fehlt" />}
            </button>
            <button className="tab" onClick={() => void logout()}>
              Abmelden
            </button>
          </nav>
        </div>
      </header>

      <main className="main">
        {view.name === 'albums' && <Albums onOpen={(id) => setView({ name: 'album', id })} />}
        {view.name === 'album' && (
          <AlbumDetail id={view.id} onBack={() => setView({ name: 'albums' })} />
        )}
        {view.name === 'account' && <Account state={state} onChanged={() => void loadState()} />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Albums({ onOpen }: { onOpen: (id: string) => void }) {
  const [albums, setAlbums] = useState<AlbumSummary[] | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [a, o] = await Promise.all([
      api.get<{ albums: AlbumSummary[] }>('/albums'),
      api.get<Overview & { ok: boolean }>('/overview'),
    ]);
    setAlbums(a.albums);
    setOverview(o);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(): Promise<void> {
    setError(null);
    try {
      await api.post('/albums', { name, eventDate: eventDate || null });
      setName('');
      setEventDate('');
      setCreating(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anlegen fehlgeschlagen.');
    }
  }

  if (!albums || !overview) return <div className="loading">Wird geladen …</div>;

  return (
    <>
      <div className="stats">
        <Stat label="Alben" value={String(overview.albums)} />
        <Stat label="Dateien" value={String(overview.files)} />
        <Stat label="Belegt" value={formatBytes(overview.bytes)} />
        {overview.failedAssets > 0 && (
          <Stat label="Fehlgeschlagen" value={String(overview.failedAssets)} warn />
        )}
      </div>

      {overview.recentUploadErrors.length > 0 && (
        <details className="panel warn-panel">
          <summary>
            {overview.recentUploadErrors.length} gemeldete Upload-Fehler von Geräten
          </summary>
          <table className="table">
            <tbody>
              {overview.recentUploadErrors.map((e, i) => (
                <tr key={i}>
                  <td className="mono small">{formatDate(e.at)}</td>
                  <td className="small">{e.filename ?? '–'}</td>
                  <td className="small muted">{e.message?.slice(0, 120) ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <div className="head-row">
        <h1>Alben</h1>
        <button className="btn" onClick={() => setCreating(!creating)}>
          {creating ? 'Abbrechen' : 'Neues Album'}
        </button>
      </div>

      {creating && (
        <div className="panel">
          <div className="form-row">
            <div>
              <label htmlFor="n">Name</label>
              <input
                id="n"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="z. B. Sommerfest 2026"
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="d">Datum (optional)</label>
              <input id="d" type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
            </div>
          </div>
          {error && <p className="error">{error}</p>}
          <button className="btn" onClick={() => void create()} disabled={name.trim().length < 2}>
            Anlegen — Links werden gleich miterzeugt
          </button>
        </div>
      )}

      {albums.length === 0 ? (
        <p className="empty">Noch keine Alben. Leg eines an, um Links zu erzeugen.</p>
      ) : (
        <div className="cards">
          {albums.map((a) => (
            <button key={a.id} className="album-card" onClick={() => onOpen(a.id)}>
              <div className="album-name">
                {a.name}
                {a.archivedAt && <span className="badge">archiviert</span>}
              </div>
              <div className="album-meta muted small">
                {a.eventDate ? formatDate(a.eventDate) : formatDate(a.createdAt)} · {a.files}{' '}
                {a.files === 1 ? 'Datei' : 'Dateien'} · {formatBytes(a.bytes)}
              </div>
              <div className="album-links small">
                {a.links.filter((l) => !l.revokedAt).length} aktive Links ·{' '}
                {a.links.reduce((s, l) => s + l.useCount, 0)} Aufrufe
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={warn ? 'stat warn' : 'stat'}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
