import path from 'node:path';

/**
 * Erzeugung dateisystemsicherer Namen.
 *
 * Alles hier verarbeitet Fremdeingaben: Albumnamen kommen aus dem Admin,
 * Uploader-Namen und Dateinamen von beliebigen Gaesten aus dem Internet. Diese
 * Werte landen in Pfaden. Entsprechend wird nicht gefiltert, was verboten ist,
 * sondern nur durchgelassen, was ausdruecklich erlaubt ist.
 */

const UMLAUTS: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'ae', Ö: 'oe', Ü: 'ue', ß: 'ss',
  á: 'a', à: 'a', â: 'a', å: 'a', ã: 'a',
  é: 'e', è: 'e', ê: 'e', ë: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', õ: 'o', ø: 'o',
  ú: 'u', ù: 'u', û: 'u',
  ç: 'c', ñ: 'n', ý: 'y',
};

/**
 * Unter Windows reservierte Geraetenamen. Die NAS laeuft zwar auf Linux, aber
 * die Dateien landen frueher oder spaeter ueber File Station oder eine
 * SMB-Freigabe auf einem Windows-Rechner.
 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export const MAX_SLUG_LENGTH = 60;

/**
 * Wandelt beliebigen Text in einen Slug aus [a-z0-9-].
 * Liefert niemals einen leeren String, '.', '..' oder einen reservierten Namen.
 */
export function slugify(input: string, fallback = 'ohne-namen'): string {
  let s = input.normalize('NFC');

  s = s.replace(/[äöüÄÖÜßáàâåãéèêëíìîïóòôõøúùûçñý]/g, (c) => UMLAUTS[c] ?? c);

  // Diakritika abtrennen und verwerfen, dann alles Verbleibende ausserhalb
  // der Allowlist zu Bindestrichen machen.
  s = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');

  if (s.length === 0 || RESERVED.has(s)) return fallback;
  return s;
}

/**
 * Normalisiert einen Uploader-Namen fuer den Abgleich, damit "Oma Erika",
 * "oma erika" und "Oma  Erika" dieselbe Person sind.
 */
export function normalizeName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Sichtbarer Uploader-Name: getrimmt, Mehrfach-Leerzeichen zusammengefasst. */
export function cleanDisplayName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 80);
}

/**
 * Reduziert einen hochgeladenen Dateinamen auf eine sichere Endung.
 *
 * Der Dateiname vom Client wird NICHT als Pfadbestandteil uebernommen - der
 * tatsaechliche Speichername wird serverseitig aus Zeitstempel und Hash
 * gebildet. Der Originalname wandert nur in die Datenbank, zur Anzeige.
 */
export function safeExtension(filename: string, mime: string): string {
  const byMime = EXT_BY_MIME[mime];
  if (byMime) return byMime;

  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(filename);
  if (!m?.[1]) return 'bin';

  const ext = m[1].toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : 'bin';
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/tiff': 'tif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
};

/**
 * Letzte Verteidigungslinie vor dem Dateisystem: stellt sicher, dass ein
 * zusammengesetzter Pfad das erlaubte Wurzelverzeichnis nicht verlaesst.
 *
 * Auch wenn slugify das bereits verhindern sollte - diese Pruefung kostet
 * nichts und faengt kuenftige Fehler ab, bei denen jemand einen ungeprueften
 * Wert einbaut.
 */
export function assertWithinRoot(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolved);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Pfad verlaesst das erlaubte Verzeichnis: ${candidate}`);
  }
}
