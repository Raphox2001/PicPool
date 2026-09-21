import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Tests der Anmeldung.
 *
 * Die Konfiguration muss vor dem ersten Import der Module stehen, weil sie
 * beim Laden eingelesen wird. Jeder Lauf bekommt ein eigenes Datenverzeichnis.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picpool-auth-'));
process.env.PICPOOL_DATA_DIR = tmp;
process.env.PICPOOL_PUBLIC_URL = 'http://127.0.0.1:8080';
process.env.PICPOOL_SECRET_KEY = crypto.randomBytes(32).toString('base64');

const auth = await import('./auth.js');
const { closeDb } = await import('../db/index.js');

after(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Passwortregeln', () => {
  test('zu kurze Passwoerter werden abgelehnt', () => {
    assert.equal(auth.checkPasswordStrength('kurz').ok, false);
    assert.equal(auth.checkPasswordStrength('elfzeichen1').ok, false);
  });

  test('zwoelf Zeichen genuegen', () => {
    assert.equal(auth.checkPasswordStrength('zwoelfzeiche').ok, true);
  });

  test('reine Ziffernfolgen und Wiederholungen werden abgelehnt', () => {
    assert.equal(auth.checkPasswordStrength('123456789012345').ok, false);
    assert.equal(auth.checkPasswordStrength('aaaaaaaaaaaaaaa').ok, false);
  });
});

describe('Benutzeranlage', () => {
  test('legt einen Benutzer an und speichert das Passwort nicht im Klartext', async () => {
    const user = await auth.createAdmin('Raphael', 'ein-gutes-passwort');
    assert.equal(user.username, 'raphael', 'Benutzername wird kleingeschrieben');
    assert.ok(user.password_hash.startsWith('$argon2id$'), 'argon2id erwartet');
    assert.ok(!user.password_hash.includes('ein-gutes-passwort'));
  });

  test('lehnt doppelte Benutzernamen ab', async () => {
    await assert.rejects(() => auth.createAdmin('RAPHAEL', 'noch-ein-passwort'));
  });

  test('lehnt unsinnige Benutzernamen ab', async () => {
    for (const bad of ['ab', 'mit leerzeichen', 'Sonderzeichen!', '../etc']) {
      await assert.rejects(() => auth.createAdmin(bad, 'ein-gutes-passwort'), `${bad} akzeptiert`);
    }
  });
});

describe('Anmeldung', () => {
  test('richtiges Passwort wird angenommen', async () => {
    const r = await auth.verifyLogin('raphael', 'ein-gutes-passwort');
    assert.equal(r.status, 'ok');
  });

  test('falsches Passwort wird abgelehnt', async () => {
    const r = await auth.verifyLogin('raphael', 'falsch-aber-lang-genug');
    assert.equal(r.status, 'invalid');
  });

  test('unbekannter Benutzer liefert dieselbe Antwort wie falsches Passwort', async () => {
    const r = await auth.verifyLogin('gibtsnicht', 'irgendwas-langes');
    assert.equal(r.status, 'invalid', 'Antwort darf Benutzernamen nicht verraten');
  });

  test('sperrt nach wiederholten Fehlversuchen', async () => {
    await auth.createAdmin('gesperrt', 'ein-gutes-passwort');

    // Vier Fehlversuche bleiben folgenlos - Vertipper sollen nicht aussperren.
    for (let i = 0; i < 4; i++) {
      const r = await auth.verifyLogin('gesperrt', 'falsch-und-lang');
      assert.equal(r.status, 'invalid');
    }
    const stillOk = await auth.verifyLogin('gesperrt', 'ein-gutes-passwort');
    assert.equal(stillOk.status, 'ok', 'nach vier Fehlversuchen noch nicht gesperrt');

    // Ab dem fuenften wird gesperrt.
    for (let i = 0; i < 5; i++) await auth.verifyLogin('gesperrt', 'falsch-und-lang');
    const locked = await auth.verifyLogin('gesperrt', 'ein-gutes-passwort');
    assert.equal(locked.status, 'locked', 'richtige Anmeldung waehrend der Sperre abgewiesen');
  });

  test('erfolgreiche Anmeldung setzt den Fehlerzaehler zurueck', async () => {
    await auth.createAdmin('zaehler', 'ein-gutes-passwort');
    await auth.verifyLogin('zaehler', 'falsch-und-lang');
    await auth.verifyLogin('zaehler', 'falsch-und-lang');
    await auth.verifyLogin('zaehler', 'ein-gutes-passwort');
    assert.equal(auth.getAdminByName('zaehler')?.failed_attempts, 0);
  });
});

describe('Zweiter Faktor', () => {
  test('verlangt nach Aktivierung einen Code', async () => {
    const user = await auth.createAdmin('mitzwei', 'ein-gutes-passwort');
    const { secret } = auth.beginTotpSetup(user);
    assert.ok(secret.length >= 26, 'Geheimnis zu kurz');

    // Vor der Bestaetigung ist die Anmeldung unveraendert.
    assert.equal((await auth.verifyLogin('mitzwei', 'ein-gutes-passwort')).status, 'ok');

    auth.enableTotp(user.id);
    assert.equal((await auth.verifyLogin('mitzwei', 'ein-gutes-passwort')).status, 'totp_required');
  });

  test('nimmt den gueltigen Code an und weist falsche ab', async () => {
    const user = await auth.createAdmin('codetest', 'ein-gutes-passwort');
    const { secret } = auth.beginTotpSetup(user);
    auth.enableTotp(user.id);

    const fresh = auth.getAdminByName('codetest')!;
    const { TOTP, Secret } = await import('otpauth');
    const code = new TOTP({
      issuer: 'PicPool',
      label: 'codetest',
      secret: Secret.fromBase32(secret),
    }).generate();

    assert.equal(auth.verifyTotp(fresh, code), true, 'gueltiger Code abgelehnt');
    assert.equal(auth.verifyTotp(fresh, '000000'), false);
    assert.equal(auth.verifyTotp(fresh, 'abcdef'), false);
    assert.equal(auth.verifyTotp(fresh, ''), false);
  });

  test('das Geheimnis liegt verschluesselt in der Datenbank', async () => {
    const user = await auth.createAdmin('verschluesselt', 'ein-gutes-passwort');
    const { secret } = auth.beginTotpSetup(user);
    const stored = auth.getAdminByName('verschluesselt')!.totp_secret_enc!;
    assert.ok(!stored.includes(secret), 'Geheimnis liegt im Klartext in der Datenbank');
  });
});

describe('Sitzungen', () => {
  test('erzeugt eine aufloesbare Sitzung', async () => {
    const user = await auth.createAdmin('sitzung', 'ein-gutes-passwort');
    const { token } = auth.createSession(user.id, { ip: '192.168.1.5' });

    const resolved = auth.resolveSession(token);
    assert.equal(resolved?.user.id, user.id);
  });

  test('das Token liegt nur gehasht in der Datenbank', async () => {
    const user = await auth.createAdmin('gehasht', 'ein-gutes-passwort');
    const { token } = auth.createSession(user.id);
    const { getDb } = await import('../db/index.js');
    const rows = getDb().prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    assert.ok(!rows.some((r) => r.id === token), 'Sitzungstoken im Klartext gespeichert');
  });

  test('erfundene Tokens werden abgewiesen', () => {
    assert.equal(auth.resolveSession('erfunden'), null);
    assert.equal(auth.resolveSession(''), null);
    assert.equal(auth.resolveSession(undefined), null);
  });

  test('Abmelden macht die Sitzung ungueltig', async () => {
    const user = await auth.createAdmin('abmelden', 'ein-gutes-passwort');
    const { token } = auth.createSession(user.id);
    auth.destroySession(token);
    assert.equal(auth.resolveSession(token), null);
  });

  test('Passwortwechsel beendet alle Sitzungen', async () => {
    const user = await auth.createAdmin('wechsel', 'ein-gutes-passwort');
    const a = auth.createSession(user.id);
    const b = auth.createSession(user.id);

    await auth.changePassword(user.id, 'ein-neues-passwort');

    assert.equal(auth.resolveSession(a.token), null, 'alte Sitzung ueberlebt den Wechsel');
    assert.equal(auth.resolveSession(b.token), null);
  });

  test('CSRF-Token passt nur zur eigenen Sitzung', async () => {
    const user = await auth.createAdmin('csrf', 'ein-gutes-passwort');
    const a = auth.createSession(user.id);
    const b = auth.createSession(user.id);

    assert.equal(auth.checkCsrf(a.token, a.csrfToken), true);
    assert.equal(auth.checkCsrf(a.token, b.csrfToken), false, 'fremdes CSRF-Token akzeptiert');
    assert.equal(auth.checkCsrf(a.token, 'erfunden'), false);
    assert.equal(auth.checkCsrf(undefined, a.csrfToken), false);
  });
});
