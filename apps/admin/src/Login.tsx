import { useState, type FormEvent } from 'react';
import { api, setCsrfToken, ApiError, type AdminState } from './api';

/**
 * Anmeldung und Ersteinrichtung.
 *
 * Beides in einer Maske: Solange kein Konto existiert, zeigt der Server
 * setupNeeded, und aus der Anmeldung wird die Einrichtung. Danach ist dieser
 * Weg geschlossen.
 */

interface Props {
  state: AdminState;
  onDone: () => void;
}

export function Login({ state, onDone }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordRepeat, setPasswordRepeat] = useState('');
  const [code, setCode] = useState('');
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setup = state.setupNeeded;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      if (setup) {
        if (password !== passwordRepeat) {
          setError('Die beiden Passwörter stimmen nicht überein.');
          return;
        }
        const res = await api.post<{ csrfToken: string }>('/setup', { username, password });
        setCsrfToken(res.csrfToken);
        onDone();
        return;
      }

      const res = await api.post<{
        csrfToken?: string;
        totpRequired?: boolean;
        pendingToken?: string;
      }>('/login', { username, password });

      if (res.totpRequired && res.pendingToken) {
        setPendingToken(res.pendingToken);
        return;
      }

      setCsrfToken(res.csrfToken ?? null);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Anmeldung fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const res = await api.post<{ csrfToken: string }>('/login/totp', {
        pendingToken,
        code,
      });
      setCsrfToken(res.csrfToken);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Der Code stimmt nicht.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (pendingToken) {
    return (
      <div className="login">
        <form className="card" onSubmit={submitTotp}>
          <h1>Bestätigung</h1>
          <p className="muted">Bitte den sechsstelligen Code aus deiner Authenticator-App eingeben.</p>

          <label htmlFor="code">Code</label>
          <input
            id="code"
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
          />

          {error && <p className="error">{error}</p>}

          <button className="btn" type="submit" disabled={busy || code.length !== 6}>
            {busy ? 'Wird geprüft …' : 'Anmelden'}
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              setPendingToken(null);
              setCode('');
              setError(null);
            }}
          >
            Abbrechen
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>{setup ? 'PicPool einrichten' : 'PicPool'}</h1>
        <p className="muted">
          {setup
            ? 'Es ist noch kein Konto vorhanden. Lege jetzt dein Administratorkonto an.'
            : 'Bitte anmelden.'}
        </p>

        <label htmlFor="u">Benutzername</label>
        <input
          id="u"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />

        <label htmlFor="p">Passwort</label>
        <input
          id="p"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={setup ? 'new-password' : 'current-password'}
          required
        />

        {setup && (
          <>
            <label htmlFor="p2">Passwort wiederholen</label>
            <input
              id="p2"
              type="password"
              value={passwordRepeat}
              onChange={(e) => setPasswordRepeat(e.target.value)}
              autoComplete="new-password"
              required
            />
            <p className="hint">Mindestens 12 Zeichen. Länge zählt mehr als Sonderzeichen.</p>
          </>
        )}

        {error && <p className="error">{error}</p>}

        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Einen Moment …' : setup ? 'Konto anlegen' : 'Anmelden'}
        </button>

        {setup && (
          <p className="hint">
            Alternativ im Container:
            <code>node apps/server/dist/cli.js admin:create &lt;name&gt;</code>
          </p>
        )}
      </form>
    </div>
  );
}
