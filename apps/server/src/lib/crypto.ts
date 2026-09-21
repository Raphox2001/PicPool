import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { getConfig } from '../config.js';

/**
 * Aus dem einen konfigurierten Hauptschluessel werden per HKDF getrennte
 * Teilschluessel abgeleitet. Denselben Schluessel gleichzeitig zum
 * Verschluesseln von Tokens, von TOTP-Secrets und zum Hashen von IPs zu
 * benutzen, waere eine vermeidbare Schwaeche: ein Fehler in einem Verwendungs-
 * zweck wuerde sonst auf alle anderen durchschlagen.
 */
type KeyPurpose = 'share-token' | 'totp-secret' | 'ip-pseudonym' | 'session';

const derived = new Map<KeyPurpose, Buffer>();

function keyFor(purpose: KeyPurpose): Buffer {
  const hit = derived.get(purpose);
  if (hit) return hit;

  const master = getConfig().secretKey;
  const key = Buffer.from(
    crypto.hkdfSync('sha256', master, Buffer.alloc(0), `picpool:${purpose}`, 32),
  );
  derived.set(purpose, key);
  return key;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * 16 Byte Zufall, base64url kodiert: 22 Zeichen, 128 Bit Entropie.
 * Nicht zu erraten und trotzdem kurz genug fuer einen handlichen QR-Code.
 */
export function generateToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** Indexierbarer Lookup-Wert. Tokens sind hochentropisch, daher genuegt SHA-256. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Verschluesselung at rest (AES-256-GCM)
// ---------------------------------------------------------------------------

/** Ergebnisformat: base64( iv(12) | authTag(16) | ciphertext ) */
export function encryptAtRest(plaintext: string, purpose: KeyPurpose): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptAtRest(payload: string, purpose: KeyPurpose): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < 12 + 16 + 1) throw new Error('Chiffrat zu kurz');

  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Sonstiges
// ---------------------------------------------------------------------------

/**
 * IPs werden nur pseudonymisiert gespeichert. Fuer Rate-Limiting und die Frage
 * "kam das vom selben Geraet" reicht das; eine Klartext-IP-Historie der Gaeste
 * will hier niemand haben.
 */
export function pseudonymizeIp(ip: string): string {
  return crypto
    .createHmac('sha256', keyFor('ip-pseudonym'))
    .update(ip, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/** Laufzeitkonstanter Vergleich fuer Geheimnisse. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function randomId(): string {
  return crypto.randomUUID();
}
