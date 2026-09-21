import net from 'node:net';

/**
 * Pruefung, ob eine Adresse in einem konfigurierten Subnetz liegt.
 *
 * Damit entscheidet sich, wer Bilder in Originalaufloesung direkt in der
 * Galerie angezeigt bekommt. Das ist eine Vertrauensentscheidung, also wird
 * hier nichts geraten: Was nicht eindeutig passt, gilt als fremd.
 *
 * Wichtig ist das Zusammenspiel mit trustProxy in app.ts. Nur wenn dort der
 * Reverse Proxy eng eingegrenzt ist, ist die Client-IP verlaesslich -
 * andernfalls koennte sich ein Gast per X-Forwarded-For eine LAN-Adresse
 * andichten.
 */

interface Cidr {
  bytes: Uint8Array;
  bits: number;
  family: 4 | 6;
}

function parseIp(ip: string): { bytes: Uint8Array; family: 4 | 6 } | null {
  // Node liefert IPv4-Adressen ueber IPv6 teils als ::ffff:192.168.0.5
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = mapped?.[1] ?? ip;

  if (net.isIPv4(addr)) {
    const parts = addr.split('.').map(Number);
    if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return { bytes: Uint8Array.from(parts), family: 4 };
  }

  if (net.isIPv6(addr)) {
    const bytes = expandIpv6(addr);
    return bytes ? { bytes, family: 6 } : null;
  }

  return null;
}

function expandIpv6(addr: string): Uint8Array | null {
  const [head, tail] = addr.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];

  if (addr.includes('::')) {
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    headParts.push(...Array<string>(missing).fill('0'), ...tailParts);
  }
  if (headParts.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const v = Number.parseInt(headParts[i]!, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

export function parseCidr(cidr: string): Cidr | null {
  const [addr, bitsRaw] = cidr.split('/');
  if (!addr || bitsRaw === undefined) return null;

  const parsed = parseIp(addr);
  if (!parsed) return null;

  const bits = Number(bitsRaw);
  const maxBits = parsed.family === 4 ? 32 : 128;
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return null;

  return { bytes: parsed.bytes, bits, family: parsed.family };
}

/** Liegt die Adresse in einem der Subnetze? */
export function isInCidrs(ip: string, cidrs: readonly string[]): boolean {
  if (cidrs.length === 0) return false;

  const addr = parseIp(ip);
  if (!addr) return false;

  for (const raw of cidrs) {
    const cidr = parseCidr(raw);
    if (!cidr || cidr.family !== addr.family) continue;
    if (matches(addr.bytes, cidr)) return true;
  }
  return false;
}

function matches(addr: Uint8Array, cidr: Cidr): boolean {
  const fullBytes = Math.floor(cidr.bits / 8);
  const restBits = cidr.bits % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (addr[i] !== cidr.bytes[i]) return false;
  }
  if (restBits === 0) return true;

  const mask = (0xff << (8 - restBits)) & 0xff;
  return (addr[fullBytes]! & mask) === (cidr.bytes[fullBytes]! & mask);
}
