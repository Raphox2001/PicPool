import { useState, useEffect } from 'react';
import { api, formatDateTime, type AdminState } from './api';

/**
 * Kontoeinstellungen: Passwort und zweiter Faktor.
 *
 * Der zweite Faktor bekommt hier viel Raum. Das Panel ist auf Wunsch
 * oeffentlich erreichbar; ohne zweiten Faktor haengt dann alles an einem
 * einzigen Passwort.
 */
export function Account({ state, onChanged }: { state: AdminState; onChanged: () => void }) {
  return (
    <>
      <h1>Konto</h1>
      <p className="muted small">
        Angemeldet als <strong>{state.user?.username}</strong>
        {state.user?.lastLoginAt ? ` · zuletzt ${formatDateTime(state.user.lastLoginAt)}` : ''}
      </p>

      <TwoFactor enabled={state.user?.totpEnabled ?? false} onChanged={onChanged} />
      <PasswordChange />
      <Updates />
    </>
  );
}

// ---------------------------------------------------------------------------

interface UpdateInfo {
  version: string;
  pending: { requestedAt: string; requestedBy: string } | null;
  latest: {
    version: string;
    url: string | null;
    publishedAt: string | null;
    notes: string;
    newer: boolean;
  } | null;
  checkError?: string;
}

function Updates() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(check: boolean): Promise<void> {
    setError(null);
    if (check) setChecking(true);
    try {
      setInfo(await api.get<UpdateInfo>(`/update${check ? '?check=1' : ''}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Abfrage fehlgeschlagen.');
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void load(false);
  }, []);

  if (!info) return null;

  async function request(): Promise<void> {
    setError(null);
    try {
      await api.post('/update', { targetVersion: info?.latest?.version ?? null });
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anforderung fehlgeschlagen.');
    }
  }

  return (
    <section className="panel">
      <h2>Version und Aktualisierung</h2>
      <p className="muted small">
        Installiert: <strong>{info.version}</strong>
      </p>

      {info.pending ? (
        <>
          <p className="ok-text">
            Aktualisierung angefordert am {formatDateTime(info.pending.requestedAt)} durch{' '}
            {info.pending.requestedBy}. Die DSM-Aufgabe führt sie beim nächsten Durchlauf aus.
          </p>
          <button
            className="btn ghost"
            onClick={async () => {
              await api.del('/update');
              await load(false);
            }}
          >
            Anforderung zurücknehmen
          </button>
        </>
      ) : (
        <>
          <p className="muted small">
            Die Abfrage bei GitHub geschieht nur auf Knopfdruck — sonst würde bei jedem
            Panelaufruf die Adresse deiner NAS an einen Dritten gemeldet.
          </p>

          <button className="btn ghost" onClick={() => void load(true)} disabled={checking}>
            {checking ? 'Wird geprüft …' : 'Nach Updates suchen'}
          </button>

          {info.checkError && <p className="error">{info.checkError}</p>}

          {info.latest &&
            (info.latest.newer ? (
              <>
                <p className="ok-text">
                  Version {info.latest.version} ist verfügbar
                  {info.latest.publishedAt ? ` (${formatDateTime(info.latest.publishedAt)})` : ''}.
                </p>
                {info.latest.notes && <pre className="notes">{info.latest.notes}</pre>}
                <p className="muted small">
                  Beim Aktualisieren wird zuerst die Datenbank gesichert, dann das Image neu
                  gebaut und neu gestartet. Das dauert ein paar Minuten, in denen PicPool kurz
                  nicht erreichbar ist.
                </p>
                <button className="btn" onClick={() => void request()}>
                  Jetzt aktualisieren
                </button>
              </>
            ) : (
              <p className="muted small">Du bist auf dem neuesten Stand.</p>
            ))}
        </>
      )}

      {error && <p className="error">{error}</p>}

      <details>
        <summary className="muted small">Wie das funktioniert</summary>
        <p className="muted small">
          Das Panel aktualisiert sich nicht selbst. Dafür bräuchte der Container Zugriff auf den
          Docker-Socket — gleichbedeutend mit Root auf der ganzen NAS. Stattdessen wird hier nur
          eine Markierungsdatei geschrieben; eine DSM-Aufgabe prüft darauf und erledigt den Rest.
          Die Einrichtung steht im README.
        </p>
      </details>
    </section>
  );
}

// ---------------------------------------------------------------------------

function TwoFactor({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function begin(): Promise<void> {
    setError(null);
    try {
      const res = await api.post<{ secret: string; qrDataUrl: string }>('/totp/setup');
      setSetup(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Einrichtung fehlgeschlagen.');
    }
  }

  async function confirm(): Promise<void> {
    setError(null);
    try {
      await api.post('/totp/enable', { code });
      setSetup(null);
      setCode('');
      setDone(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Der Code stimmt nicht.');
      setCode('');
    }
  }

  async function disable(): Promise<void> {
    setError(null);
    try {
      await api.post('/totp/disable', { password });
      setPassword('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Abschalten fehlgeschlagen.');
    }
  }

  if (enabled) {
    return (
      <section className="panel">
        <h2>
          Zweiter Faktor <span className="badge ok">aktiv</span>
        </h2>
        <p className="muted small">
          Bei der Anmeldung wird zusätzlich ein Code aus deiner Authenticator-App verlangt.
        </p>

        <details>
          <summary className="muted small">Zweiten Faktor abschalten</summary>
          <p className="muted small">
            Danach genügt wieder das Passwort allein. Bei einem öffentlich erreichbaren Panel ist
            davon abzuraten.
          </p>
          <label htmlFor="pw-off">Passwort zur Bestätigung</label>
          <input
            id="pw-off"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {error && <p className="error">{error}</p>}
          <button className="btn ghost danger" onClick={() => void disable()} disabled={!password}>
            Abschalten
          </button>
        </details>
      </section>
    );
  }

  return (
    <section className="panel warn-panel">
      <h2>Zweiter Faktor</h2>

      {done ? (
        <p className="ok-text">Eingerichtet. Ab der nächsten Anmeldung wird ein Code verlangt.</p>
      ) : !setup ? (
        <>
          <p>
            Dein Panel ist aus dem Internet erreichbar. Ohne zweiten Faktor hängt alles an einem
            einzigen Passwort — ein Code aus einer Authenticator-App schließt diese Lücke.
          </p>
          <button className="btn" onClick={() => void begin()}>
            Jetzt einrichten
          </button>
        </>
      ) : (
        <>
          <ol className="steps">
            <li>
              Öffne deine Authenticator-App (z. B. Aegis, 2FAS, Google Authenticator) und scanne
              diesen Code:
              <img className="qr" src={setup.qrDataUrl} alt="QR-Code zur Einrichtung" />
            </li>
            <li>
              Falls Scannen nicht geht, gib das Geheimnis von Hand ein:
              <code className="secret">{setup.secret}</code>
            </li>
            <li>
              Zur Bestätigung den angezeigten Code eintragen:
              <input
                className="code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
              />
            </li>
          </ol>

          {error && <p className="error">{error}</p>}

          <div className="row-actions">
            <button className="btn" onClick={() => void confirm()} disabled={code.length !== 6}>
              Aktivieren
            </button>
            <button className="btn ghost" onClick={() => setSetup(null)}>
              Abbrechen
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function PasswordChange() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    setMessage(null);

    if (next !== repeat) {
      setError('Die beiden neuen Passwörter stimmen nicht überein.');
      return;
    }

    try {
      const res = await api.post<{ message?: string }>('/password', {
        currentPassword: current,
        newPassword: next,
      });
      setMessage(res.message ?? 'Passwort geändert.');
      setCurrent('');
      setNext('');
      setRepeat('');
      // Der Server beendet alle Sitzungen, auch diese. Nach kurzem Hinweis
      // landet man wieder auf der Anmeldemaske.
      window.setTimeout(() => window.location.reload(), 2200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ändern fehlgeschlagen.');
    }
  }

  return (
    <section className="panel">
      <h2>Passwort ändern</h2>
      <p className="muted small">
        Nach der Änderung werden alle Sitzungen beendet — auch diese hier.
      </p>

      <label htmlFor="cur">Aktuelles Passwort</label>
      <input
        id="cur"
        type="password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        autoComplete="current-password"
      />

      <label htmlFor="new">Neues Passwort</label>
      <input
        id="new"
        type="password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        autoComplete="new-password"
      />

      <label htmlFor="rep">Neues Passwort wiederholen</label>
      <input
        id="rep"
        type="password"
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
        autoComplete="new-password"
      />

      <p className="hint">Mindestens 12 Zeichen. Länge zählt mehr als Sonderzeichen.</p>

      {error && <p className="error">{error}</p>}
      {message && <p className="ok-text">{message}</p>}

      <button className="btn" onClick={() => void submit()} disabled={!current || next.length < 12}>
        Ändern
      </button>
    </section>
  );
}
