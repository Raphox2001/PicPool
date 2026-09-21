import { useState } from 'react';
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
    </>
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
