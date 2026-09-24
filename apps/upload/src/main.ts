import * as tus from 'tus-js-client';
import './style.css';

/**
 * Upload-Seite fuer Gaeste.
 *
 * Entwurfsgrundsaetze:
 *  - Keine Anmeldung, keine App, keine Erklaerung. Name eintippen, Knopf
 *    druecken, fertig.
 *  - Ein Abbruch ist der Normalfall, nicht die Ausnahme: Mobilfunk bricht weg,
 *    Bildschirme sperren sich, Seiten werden neu geladen. Deshalb tus mit
 *    Wiederaufnahme, mehrfachem stillen Neuversuch und Fortsetzung ueber
 *    Seitenaufrufe hinweg.
 *  - Der Zustand muss ohne Lesen erkennbar sein: grosses Haekchen, grosses
 *    Kreuz, ein Zaehler im Fuss.
 */

/**
 * Gleichzeitigkeit und Abschnittsgroesse.
 *
 * Ursprünglich 3 × 6 MB. Beim Test mit einem Pixel 7 im WLAN zeigte sich ein
 * klares Muster: Die ersten Dateien liefen durch, danach scheiterte jeder
 * weitere PATCH sofort auf Netzwerkebene - der Server sah die Anfrage nie,
 * waehrend kleine Anfragen (HEAD, POST ohne Koerper) weiter durchgingen.
 *
 * 2 × 2 MB hält deutlich weniger Daten gleichzeitig in der Luft (4 statt
 * 18 MB), macht jede einzelne Anfrage kurzlebiger und damit unempfindlicher
 * gegen Abbrüche. Tempo kostet das kaum: der Engpass ist ohnehin die
 * Funkstrecke, nicht die Anzahl der Verbindungen.
 */
const CONCURRENCY = 2;

/**
 * Abschnittsgroessen in absteigender Reihenfolge.
 *
 * Manche Netzwerkstrecken bekommen grosse Uploads nicht durch, waehrend
 * kleine Anfragen problemlos laufen - beobachtet im Geraetetest: HEAD und
 * POST kamen an, die grossen PATCH-Anfragen erreichten den Server nie.
 * Die Ursache kann vieles sein (WLAN-Zugangspunkt, MTU, Paketfilter) und
 * liegt ausserhalb dessen, was PicPool beeinflussen kann.
 *
 * Statt die Ursache zu erraten, passt sich der Uploader an: Scheitert eine
 * Datei, wird sie automatisch mit kleineren Paketen erneut versucht. Erst
 * wenn auch 128 KB nicht durchgehen, gilt sie als fehlgeschlagen. Dank tus
 * geht dabei nichts verloren - es wird an der Abbruchstelle weitergemacht.
 */
const CHUNK_SIZES = [2 * 1024 * 1024, 512 * 1024, 128 * 1024];

/**
 * Wiederholungsleitern je Paketgroesse.
 *
 * Auf den oberen Stufen wird bewusst schnell aufgegeben: Kommt eine
 * Paketgroesse auf dieser Strecke grundsaetzlich nicht durch, ist Warten
 * sinnlos - kleinere Pakete zu probieren bringt mehr. Gemessen: mit einer
 * langen Leiter auf Stufe 1 dauerte es 90 Sekunden bis zum ersten
 * Verkleinern, mit der kurzen nur wenige.
 *
 * Auf der letzten Stufe wird dagegen geduldig weiterprobiert - dort geht es
 * nicht mehr um die Paketgroesse, sondern um eine wacklige Verbindung, und
 * die kommt oft von selbst zurueck.
 */
const RETRY_LADDERS = [
  [0, 500, 2000],
  [0, 1000, 3000],
  [0, 1000, 3000, 8000, 15000, 30000],
];
const NAME_KEY = 'picpool.name';

type State = 'wartet' | 'laeuft' | 'fertig' | 'fehler';

interface Item {
  file: File;
  row: HTMLElement;
  fill: HTMLElement;
  note: HTMLElement;
  mark: HTMLElement;
  thumbUrl: string | null;
  state: State;
  assetId?: string;
  duplicate?: boolean;
  upload?: tus.Upload;
  /** Fuer den Fehlerbericht: wie weit war der Upload gekommen. */
  bytesSent: number;
  /**
   * Wann die Datei ausgewaehlt wurde. Zusammen mit `dateiLesbar` zeigt das,
   * ob Dateien mit zunehmender Wartezeit unlesbar werden - genau das Muster,
   * das Android erzeugt, wenn es einen Verweis wieder einzieht.
   */
  queuedAt: number;
  /** Gesetzt, wenn die Datei am Ende nicht mehr lesbar war. */
  unreadable?: boolean;
  /**
   * Die eigene Kopie der Datei. Sobald sie steht, wird aus ihr hochgeladen
   * und nicht mehr aus dem Verweis, den Android uns jederzeit entziehen darf.
   */
  data?: Blob;
  /** Erst wenn das Sichern durch ist, darf der Upload starten. */
  prepared?: boolean;
  /** Fuer das Vorschaubild: zeigt nach dem Sichern auf die Kopie. */
  thumbEl: HTMLImageElement | null;
  attempts: number;
  lastErrorDetail?: string;
  /** Index in CHUNK_SIZES - steigt bei jedem Fehlschlag um eins. */
  chunkLevel: number;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element fehlt: ${id}`);
  return el as T;
};

const token = extractToken();
const items: Item[] = [];
let uploaderName = '';
let running = 0;
let wakeLock: WakeLockSentinel | null = null;

/**
 * Beobachtung der Seitensichtbarkeit.
 *
 * Android Chrome drosselt Hintergrund-Tabs teils so stark, dass laufende
 * Uploads stehen bleiben, waehrend kleine Anfragen weiter durchgehen. Von
 * aussen sieht das aus wie ein Netzproblem. Diese Zaehler machen den
 * Unterschied im Fehlerbericht sichtbar.
 */
const visibility = {
  hiddenCount: 0,
  hiddenMsTotal: 0,
  lastHiddenAt: 0,
  wasEverHidden: false,
};

function extractToken(): string {
  const m = /\/u\/([A-Za-z0-9_-]{10,64})/.exec(window.location.pathname);
  return m?.[1] ?? '';
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

void init();

async function init(): Promise<void> {
  detectInAppBrowser();

  if (!token) {
    showFatal('Dieser Link ist unvollständig. Bitte den Link noch einmal öffnen.');
    return;
  }

  try {
    const res = await fetch(`/api/u/${token}`, { headers: { Accept: 'application/json' } });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      showFatal(data?.message ?? 'Dieser Link ist nicht gültig oder abgelaufen.');
      return;
    }

    $('album').textContent = data.album.name;
    document.title = `Fotos hochladen – ${data.album.name}`;

    const parts: string[] = [];
    if (data.album.eventDate) parts.push(formatDate(data.album.eventDate));
    if (data.album.description) parts.push(data.album.description);
    $('subtitle').textContent = parts.join(' · ');

    $('step-name').classList.remove('hidden');
    $('step-pick').classList.remove('hidden');
  } catch {
    showFatal('Keine Verbindung zum Server. Bitte später noch einmal versuchen.');
    return;
  }

  setupName();
  setupPicker();
  setupGuards();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Name
// ---------------------------------------------------------------------------

function setupName(): void {
  const input = $<HTMLInputElement>('name');
  const button = $<HTMLButtonElement>('pick');
  const hint = $('pick-hint');

  // Wer schon einmal hochgeladen hat, soll den Namen nicht erneut tippen.
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) input.value = saved;
  } catch {
    /* Privater Modus - dann eben ohne Merken */
  }

  const sync = (): void => {
    uploaderName = input.value.trim();
    const ok = uploaderName.length >= 2;
    button.disabled = !ok;
    hint.textContent = ok ? 'Du kannst so viele Dateien auswählen, wie du möchtest.' : 'Bitte zuerst den Namen eintragen.';
    if (ok) {
      try {
        localStorage.setItem(NAME_KEY, uploaderName);
      } catch {
        /* egal */
      }
    }
  };

  input.addEventListener('input', sync);
  input.addEventListener('change', sync);
  // Eingabetaste schliesst die Tastatur, statt ein Formular abzuschicken.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  sync();
}

// ---------------------------------------------------------------------------
// Auswahl
// ---------------------------------------------------------------------------

function setupPicker(): void {
  const button = $<HTMLButtonElement>('pick');
  const input = $<HTMLInputElement>('file');

  button.addEventListener('click', () => input.click());
  $('more').addEventListener('click', () => input.click());
  $('retry').addEventListener('click', retryFailed);

  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    // Zuruecksetzen, damit dieselbe Datei erneut gewaehlt werden kann.
    input.value = '';
    if (files.length > 0) addFiles(files);
  });
}

function addFiles(files: File[]): void {
  $('done').classList.add('hidden');
  $('failed').classList.add('hidden');
  $('list').classList.remove('hidden');
  $('bar').classList.remove('hidden');

  const fresh = files.map((file) => createRow(file));
  items.push(...fresh);

  void acquireWakeLock();
  // Zuerst sichern, dann hochladen - siehe secureFiles.
  void secureFiles(fresh);
  render();
}

/**
 * Obergrenze fuer die Kopien im Speicher.
 *
 * Darueber hinaus wird nicht mehr kopiert, sondern wie zuvor direkt aus dem
 * Verweis gelesen. Lieber ein Upload, der es versuchen muss, als eine Seite,
 * die dem Handy den Speicher wegnimmt.
 */
const SNAPSHOT_BUDGET = 512 * 1024 * 1024;
let snapshotUsed = 0;

/**
 * Zieht sofort beim Auswaehlen eine eigene Kopie jeder Datei.
 *
 * Android reicht dem Browser keine Datei, sondern einen Verweis darauf - und
 * der ist kurzlebig. Gemessen am 24.09.2026: Nach acht bis fuenfundzwanzig
 * Sekunden war nichts mehr zu lesen. Bei zwanzig Dateien in der Schlange
 * kamen deshalb nur die ersten beiden an, alle weiteren scheiterten mit einem
 * Fehler, der von aussen wie ein Funkloch aussah - null Bytes gesendet, keine
 * HTTP-Antwort.
 *
 * Die Kopie kostet Speicher, aber sie gehoert uns. Sie entsteht in der
 * Reihenfolge der Auswahl, und jeder fertig gesicherte Eintrag darf sofort
 * losgeschickt werden - das Lesen von der Platte ist um Groessenordnungen
 * schneller als der Upload, das Sichern laeuft dem Hochladen also davon.
 */
async function secureFiles(fresh: Item[]): Promise<void> {
  for (const item of fresh) {
    if (item.state === 'wartet') item.note.textContent = 'wird gesichert …';

    try {
      if (snapshotUsed + item.file.size <= SNAPSHOT_BUDGET) {
        item.data = new Blob([await item.file.arrayBuffer()], { type: item.file.type });
        snapshotUsed += item.file.size;
        adoptThumb(item);
      }
      item.prepared = true;
      if (item.state === 'wartet') item.note.textContent = 'wartet';
    } catch {
      // Schon hier nicht lesbar: Der Verweis war tot, bevor wir ihn benutzen
      // konnten. Ein Upload-Versuch waere reine Zeitverschwendung.
      markUnreadable(item);
    }

    pump();
  }

  render();
}

/**
 * Laesst das Vorschaubild auf die Kopie zeigen.
 *
 * Sonst bricht es genauso weg wie der Upload: Ein Objekt-URL auf den
 * Android-Verweis zeigt ins Leere, sobald der eingezogen wurde - der Gast
 * saehe kaputte Bilder neben seinen Dateien.
 */
function adoptThumb(item: Item): void {
  if (!item.thumbEl || !item.data) return;
  const url = URL.createObjectURL(item.data);
  releaseThumb(item);
  item.thumbUrl = url;
  item.thumbEl.src = url;
}

/** Eine Datei, die schon beim Auswaehlen nicht mehr zu lesen war. */
function markUnreadable(item: Item): void {
  item.state = 'fehler';
  item.unreadable = true;
  item.prepared = true;
  item.row.classList.add('err');
  item.mark.textContent = '✕';
  item.note.textContent = UNREADABLE_NOTE;
  item.lastErrorDetail = 'Datei liess sich schon beim Auswaehlen nicht lesen';
  reportError(item, new Error('Datei nicht lesbar'), null, true);
}

function createRow(file: File): Item {
  const row = document.createElement('div');
  row.className = 'row';

  const isImage = file.type.startsWith('image/');
  let thumbUrl: string | null = null;

  const thumb = document.createElement(isImage ? 'img' : 'div');
  thumb.className = 'thumb';
  if (isImage) {
    thumbUrl = URL.createObjectURL(file);
    (thumb as HTMLImageElement).src = thumbUrl;
    (thumb as HTMLImageElement).alt = '';
  } else {
    thumb.textContent = '🎬';
    thumb.setAttribute('style', 'display:flex;align-items:center;justify-content:center;font-size:1.5rem');
  }

  const main = document.createElement('div');
  main.className = 'row-main';

  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = file.name;

  const note = document.createElement('div');
  note.className = 'row-note';
  note.textContent = 'wartet';

  const track = document.createElement('div');
  track.className = 'track';
  const fill = document.createElement('div');
  fill.className = 'fill';
  track.appendChild(fill);

  main.append(name, note, track);

  const mark = document.createElement('div');
  mark.className = 'mark';

  row.append(thumb, main, mark);
  $('list').appendChild(row);

  return {
    file, row, fill, note, mark, thumbUrl,
    thumbEl: isImage ? (thumb as HTMLImageElement) : null,
    state: 'wartet', bytesSent: 0, attempts: 0, chunkLevel: 0,
    queuedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/** Startet so viele Uploads, wie gleichzeitig erlaubt sind. */
function pump(): void {
  while (running < CONCURRENCY) {
    // Nur gesicherte Eintraege: alles andere wartet noch auf seine Kopie.
    const next = items.find((i) => i.state === 'wartet' && i.prepared);
    if (!next) break;
    startUpload(next);
  }

  if (running === 0) finish();
}

function startUpload(item: Item): void {
  item.state = 'laeuft';
  item.note.textContent = 'wird hochgeladen …';
  item.attempts++;
  running++;

  const chunkSize = CHUNK_SIZES[item.chunkLevel] ?? CHUNK_SIZES[CHUNK_SIZES.length - 1]!;

  // Aus der Kopie, wenn es eine gibt - siehe secureFiles.
  const upload = new tus.Upload(item.data ?? item.file, {
    endpoint: '/api/upload',
    chunkSize,
    // Erst nach mehreren stillen Neuversuchen gilt ein Upload als
    // gescheitert. Ein kurzer Funkloch-Moment darf den Gast nicht behelligen.
    retryDelays: RETRY_LADDERS[item.chunkLevel] ?? RETRY_LADDERS[RETRY_LADDERS.length - 1]!,
    removeFingerprintOnSuccess: true,
    metadata: {
      filename: item.file.name,
      filetype: item.file.type,
      token,
      uploaderName,
    },
    onProgress(sent, total) {
      item.bytesSent = sent;
      const pct = total > 0 ? (sent / total) * 100 : 0;
      item.fill.style.width = `${pct.toFixed(1)}%`;
      item.note.textContent = `${formatBytes(sent)} von ${formatBytes(total)}`;
      renderBar();
    },
    onSuccess(payload: unknown) {
      const info = readServerAnswer(payload);
      item.assetId = info.assetId;
      item.duplicate = info.duplicate;
      markDone(item, info.duplicate === true);
    },
    onError(err: Error) {
      void markFailed(item, err, upload);
    },
  });

  item.upload = upload;

  // Ein zuvor abgebrochener Upload derselben Datei wird fortgesetzt, statt
  // von vorn zu beginnen - auch ueber einen Seitenneuaufbau hinweg.
  upload
    .findPreviousUploads()
    .then((previous) => {
      if (previous.length > 0 && previous[0]) {
        upload.resumeFromPreviousUpload(previous[0]);
        item.note.textContent = 'wird fortgesetzt …';
      }
      upload.start();
    })
    .catch(() => upload.start());
}

/** Liest die JSON-Antwort unseres Servers aus der tus-Rueckmeldung. */
function readServerAnswer(payload: unknown): { assetId?: string; duplicate?: boolean } {
  try {
    const res = (payload as { lastResponse?: { getBody?: () => string } })?.lastResponse;
    const body = res?.getBody?.();
    if (!body) return {};
    const parsed = JSON.parse(body) as { assetId?: string; duplicate?: boolean };
    return { assetId: parsed.assetId, duplicate: parsed.duplicate };
  } catch {
    return {};
  }
}

function markDone(item: Item, duplicate: boolean): void {
  item.state = 'fertig';
  item.row.classList.remove('err');
  item.row.classList.add('ok');
  item.fill.style.width = '100%';
  item.mark.textContent = '✓';
  item.note.textContent = duplicate ? 'war schon da' : 'angekommen';
  releaseThumb(item);
  running--;
  render();
  pump();
}

async function markFailed(item: Item, err: Error, upload: tus.Upload): Promise<void> {
  running--;

  // Erst die Datei selbst pruefen, bevor ueber kleinere Pakete nachgedacht
  // wird: Ging kein einziges Byte raus, liegt es womoeglich gar nicht am Netz.
  const unreadable =
    isTransportError(err) && item.bytesSent === 0 && !(await isFileStillReadable(item.file));

  // Nur Netz- und Serverfehler rechtfertigen einen Versuch mit kleineren
  // Paketen. Eine abgelehnte Datei oder ein ungueltiger Link werden dadurch
  // nicht besser - da waere ein erneuter Versuch nur Zeitverschwendung.
  const worthShrinking =
    !unreadable && isTransportError(err) && item.chunkLevel < CHUNK_SIZES.length - 1;

  if (worthShrinking) {
    item.chunkLevel++;
    item.state = 'wartet';
    item.fill.style.width = '0';
    item.row.classList.remove('err', 'ok');
    item.mark.textContent = '';
    const kb = Math.round(CHUNK_SIZES[item.chunkLevel]! / 1024);
    item.note.textContent = `neuer Versuch mit kleineren Paketen (${kb} KB) …`;
    render();
    pump();
    return;
  }

  // Endgueltig gescheitert - erst jetzt wird gemeldet, damit das Log nicht
  // mit Zwischenversuchen volllaeuft.
  reportError(item, err, upload, unreadable);

  item.state = 'fehler';
  item.unreadable = unreadable;
  item.row.classList.remove('ok');
  item.row.classList.add('err');
  item.mark.textContent = '✕';
  item.note.textContent = unreadable ? UNREADABLE_NOTE : explainError(err);
  render();
  pump();
}

/** Was der Gast liest, wenn die Datei selbst nicht mehr greifbar ist. */
const UNREADABLE_NOTE = 'nicht mehr lesbar – bitte neu auswählen';

/**
 * Prueft, ob die Datei ueberhaupt noch lesbar ist.
 *
 * Android reicht dem Browser keine Datei, sondern einen Verweis darauf, den
 * das System wieder einziehen darf - etwa wenn die Aufnahme aus der Cloud kam
 * oder die Galerie zwischendurch aufgeraeumt hat. Bei zwanzig Dateien in der
 * Schlange sind die hinteren schnell zehn Minuten alt.
 *
 * Der Upload meldet dann einen reinen Netzwerkfehler ohne HTTP-Antwort -
 * aeusserlich nicht von einem Funkloch zu unterscheiden, obwohl nie ein Byte
 * das Geraet verlassen hat. Ein einzelnes Byte zu lesen kostet nichts und
 * trennt die beiden Faelle.
 */
async function isFileStillReadable(file: File): Promise<boolean> {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/**
 * Unterscheidet Transportfehler von inhaltlichen Ablehnungen.
 *
 * Ein Transportfehler ist daran zu erkennen, dass gar keine HTTP-Antwort
 * ankam oder der Server einen internen Fehler meldete. Eine 4xx-Antwort ist
 * dagegen eine bewusste Ablehnung.
 */
function isTransportError(err: Error): boolean {
  const status = (err as Error & { originalResponse?: { getStatus?: () => number } })
    .originalResponse?.getStatus?.();
  if (status === undefined || status === 0) return true;
  return status >= 500;
}

/**
 * Meldet den technischen Fehler an den Server.
 *
 * Der Gast bekommt einen verstaendlichen Satz zu lesen; die Einzelheiten
 * gehoeren ins Serverlog. Ohne das waere ein Fehlschlag auf einem fremden
 * Handy nicht nachvollziehbar - genau die Blindheit, die den Photo Request
 * so mühsam macht.
 */
function reportError(item: Item, err: Error, upload: tus.Upload | null, unreadable = false): void {
  const anyErr = err as Error & {
    originalResponse?: { getStatus?: () => number; getBody?: () => string };
    originalRequest?: { getMethod?: () => string; getURL?: () => string };
    causingError?: Error;
  };

  let httpStatus: number | undefined;
  let responseBody: string | undefined;
  try {
    httpStatus = anyErr.originalResponse?.getStatus?.();
    responseBody = anyErr.originalResponse?.getBody?.()?.slice(0, 900);
  } catch {
    /* Antwort nicht lesbar */
  }

  // Der eigentliche Grund steckt bei tus haeufig im verschachtelten Fehler -
  // die aeussere Meldung ist oft nur "tus: failed to upload chunk".
  const inner = anyErr.causingError;
  const message = [
    err.name,
    err.message,
    inner ? `| Ursache: ${inner.name}: ${inner.message}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 900);

  const payload = {
    filename: item.file.name,
    fileSize: item.file.size,
    fileType: item.file.type || '(leer)',
    phase: anyErr.originalRequest?.getMethod?.() ?? 'unbekannt',
    message,
    httpStatus,
    responseBody,
    uploadUrl: upload?.url ?? undefined,
    bytesSent: item.bytesSent,
    attempt: item.attempts,
    userAgent: navigator.userAgent.slice(0, 380),
    // Umstaende zum Zeitpunkt des Fehlers. Damit laesst sich unterscheiden,
    // ob der Tab im Hintergrund gedrosselt wurde, das Netz weg war oder
    // schlicht zu viel gleichzeitig lief.
    context: [
      `sichtbarkeit=${document.visibilityState}`,
      `warVerdeckt=${visibility.wasEverHidden ? `ja(${visibility.hiddenCount}x, ${Math.round(visibility.hiddenMsTotal / 1000)}s)` : 'nein'}`,
      `online=${navigator.onLine}`,
      `gleichzeitig=${running}`,
      `wachhalten=${'wakeLock' in navigator ? (wakeLock ? 'aktiv' : 'verfuegbar') : 'nicht verfuegbar'}`,
      `sichererKontext=${window.isSecureContext}`,
      `netz=${describeConnection()}`,
      // Wichtig fuer die Auswertung: bis zu welcher Paketgroesse
      // heruntergegangen wurde, bevor aufgegeben wurde.
      `chunkStufe=${item.chunkLevel + 1}/${CHUNK_SIZES.length}`,
      `chunk=${Math.round((CHUNK_SIZES[item.chunkLevel] ?? 0) / 1024)}KB`,
      `parallel=${CONCURRENCY}`,
      // Der wichtigste Unterschied im Fehlerbericht: lag es am Netz oder war
      // die Datei schon nicht mehr da?
      `dateiLesbar=${unreadable ? 'nein' : 'ja'}`,
      `wartezeit=${Math.round((Date.now() - item.queuedAt) / 1000)}s`,
    ].join(' '),
  };

  item.lastErrorDetail = unreadable
    ? `Datei nicht mehr lesbar (${message})`
    : `${message}${httpStatus ? ` [HTTP ${httpStatus}]` : ''}`;

  try {
    const body = JSON.stringify(payload);
    // sendBeacon ueberlebt auch das Schliessen der Seite; fetch ist der
    // Rueckfall, wenn der Browser es nicht kennt.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(`/api/u/${token}/report`, new Blob([body], { type: 'application/json' }));
    } else {
      void fetch(`/api/u/${token}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      });
    }
  } catch {
    /* Die Meldung ist eine Zugabe und darf nie selbst zum Problem werden. */
  }
}

/** Netzwerkart, soweit der Browser sie preisgibt (nicht ueberall vorhanden). */
function describeConnection(): string {
  const c = (navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
  }).connection;
  if (!c) return 'unbekannt';
  return [
    c.effectiveType ?? '?',
    c.downlink !== undefined ? `${c.downlink}Mbit` : '',
    c.rtt !== undefined ? `${c.rtt}ms` : '',
    c.saveData ? 'datensparmodus' : '',
  ]
    .filter(Boolean)
    .join('/');
}

/**
 * Uebersetzt technische Fehler in etwas, das ein Gast verstehen kann.
 * "HTTP 415" hilft niemandem; "Dateityp wird nicht angenommen" schon.
 */
function explainError(err: Error): string {
  const text = String((err as { originalResponse?: { getBody?: () => string } })?.originalResponse?.getBody?.() ?? err.message ?? '');

  if (/415|Dateityp|Fotos und Videos/i.test(text)) return 'Dieser Dateityp wird nicht angenommen';
  if (/413|zu gross|Speichergrenze|voll/i.test(text)) return 'Datei zu groß oder Album voll';
  if (/403|gültig|gueltig/i.test(text)) return 'Der Link ist nicht mehr gültig';
  if (/Namen/i.test(text)) return 'Bitte Namen eintragen';
  return 'nicht geklappt – Verbindung?';
}

function retryFailed(): void {
  for (const item of items) {
    if (item.state !== 'fehler') continue;
    // Ohne Kopie und ohne lesbaren Verweis gibt es nichts zu wiederholen -
    // diese Datei muss der Gast neu auswaehlen. Ein Neuversuch wuerde nur
    // wieder scheitern und den Eindruck erwecken, es liege am Netz.
    if (item.unreadable && !item.data) continue;
    item.state = 'wartet';
    item.row.classList.remove('err');
    item.mark.textContent = '';
    item.fill.style.width = '0';
    item.note.textContent = 'wartet';
  }
  $('failed').classList.add('hidden');
  void acquireWakeLock();
  pump();
  render();
}

// ---------------------------------------------------------------------------
// Anzeige
// ---------------------------------------------------------------------------

function render(): void {
  renderBar();

  const pending = items.some((i) => i.state === 'wartet' || i.state === 'laeuft');
  if (pending) {
    $('done').classList.add('hidden');
    $('failed').classList.add('hidden');
  }
}

function renderBar(): void {
  const total = items.length;
  if (total === 0) return;

  const done = items.filter((i) => i.state === 'fertig').length;
  const failed = items.filter((i) => i.state === 'fehler').length;
  const active = items.filter((i) => i.state === 'laeuft').length;

  $('bar-count').textContent = `${done} von ${total} hochgeladen`;
  $('bar-note').textContent = failed > 0 ? `${failed} fehlgeschlagen` : active > 0 ? 'Bildschirm bitte anlassen' : '';

  const pct = ((done + failed) / total) * 100;
  $('bar-fill').style.width = `${pct.toFixed(1)}%`;
}

/** Wird aufgerufen, sobald nichts mehr laeuft. */
function finish(): void {
  const pending = items.some((i) => i.state === 'wartet' || i.state === 'laeuft');
  if (pending || items.length === 0) return;

  void releaseWakeLock();

  const done = items.filter((i) => i.state === 'fertig').length;
  const failed = items.filter((i) => i.state === 'fehler').length;

  if (failed > 0) {
    $('failed').classList.remove('hidden');
    $('failed-title').textContent =
      failed === 1 ? 'Eine Datei konnte nicht hochgeladen werden' : `${failed} Dateien konnten nicht hochgeladen werden`;

    // Bei unlesbaren Dateien hilft der Satz vom schlechten Empfang nicht
    // weiter - "nochmal versuchen" auch nicht, denn der Verweis bleibt tot.
    // Hier hilft nur, sie erneut auszuwaehlen.
    const unreadable = items.filter((i) => i.state === 'fehler' && i.unreadable).length;
    $('failed-text').textContent =
      unreadable === failed
        ? 'Dein Handy konnte diese Dateien nicht mehr lesen — Android gibt sie nach einer Weile wieder frei. Bitte wähle sie noch einmal aus, am besten in kleineren Gruppen.'
        : unreadable > 0
          ? `Bei ${unreadable} davon konnte dein Handy die Datei nicht mehr lesen; die bitte noch einmal auswählen. Der Rest liegt meistens am Empfang.`
          : 'Das liegt meistens am Empfang. Ein erneuter Versuch klappt fast immer.';

    renderErrorDetails();
  }

  if (done > 0) {
    $('done').classList.remove('hidden');
    $('done-title').textContent = failed === 0 ? 'Fertig!' : 'Teilweise fertig';
    $('done-text').textContent =
      failed === 0
        ? done === 1
          ? 'Deine Datei ist angekommen. Vielen Dank!'
          : `Alle ${done} Dateien sind angekommen. Vielen Dank!`
        : `${done} von ${items.length} Dateien sind angekommen.`;
  }

  // Gegenprobe beim Server: erst wenn er die Dateien bestaetigt, ist es
  // wirklich fertig. Dass die Bytes angekommen sind, genuegt nicht.
  void confirmWithServer();
}

/**
 * Zeigt die technischen Einzelheiten zusammengeklappt an.
 *
 * Ein Gast braucht das nicht und sieht es auch nicht von selbst. Beim Testen
 * auf einem fremden Gerät ist es dagegen der schnellste Weg an die Ursache -
 * ohne Kabel, ohne Entwicklerkonsole.
 */
function renderErrorDetails(): void {
  const host = $('failed');
  host.querySelector('.details')?.remove();

  const failedItems = items.filter((i) => i.state === 'fehler');
  if (failedItems.length === 0) return;

  const details = document.createElement('details');
  details.className = 'details';

  const summary = document.createElement('summary');
  summary.textContent = 'Technische Einzelheiten';
  details.appendChild(summary);

  const pre = document.createElement('pre');
  pre.textContent = failedItems
    .map((i) =>
      [
        `${i.file.name}  (${formatBytes(i.file.size)}, ${i.file.type || 'Typ unbekannt'})`,
        `  übertragen: ${formatBytes(i.bytesSent)}`,
        `  Fehler: ${i.lastErrorDetail ?? 'unbekannt'}`,
      ].join('\n'),
    )
    .join('\n\n');
  details.appendChild(pre);

  host.appendChild(details);
}

async function confirmWithServer(): Promise<void> {
  const ids = items.map((i) => i.assetId).filter((x): x is string => Boolean(x));
  if (ids.length === 0) return;

  try {
    const res = await fetch(`/api/u/${token}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: ids }),
    });
    if (!res.ok) return;

    const data = (await res.json()) as { assets?: Array<{ id: string; status: string }> };
    const known = new Set((data.assets ?? []).map((a) => a.id));
    const missing = ids.filter((id) => !known.has(id));

    if (missing.length > 0) {
      $('bar-note').textContent = 'Bestätigung steht aus';
    }
  } catch {
    /* Die Gegenprobe ist eine Zugabe; ihr Ausfall aendert nichts am Ergebnis. */
  }
}

function releaseThumb(item: Item): void {
  if (item.thumbUrl) {
    URL.revokeObjectURL(item.thumbUrl);
    item.thumbUrl = null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function showFatal(message: string): void {
  $('album').textContent = 'Fotos hochladen';
  $('fatal-text').textContent = message;
  $('fatal').classList.remove('hidden');
  $('step-name').classList.add('hidden');
  $('step-pick').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Schutzmassnahmen gegen abgebrochene Uploads
// ---------------------------------------------------------------------------

function setupGuards(): void {
  // Warnung beim Verlassen, solange noch etwas laeuft.
  window.addEventListener('beforeunload', (e) => {
    if (items.some((i) => i.state === 'laeuft' || i.state === 'wartet')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // iOS gibt die Sperre frei, sobald der Tab in den Hintergrund geht. Kommt
  // der Nutzer zurueck, wird sie neu angefordert.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      visibility.hiddenCount++;
      visibility.wasEverHidden = true;
      visibility.lastHiddenAt = Date.now();
      return;
    }

    if (visibility.lastHiddenAt > 0) {
      visibility.hiddenMsTotal += Date.now() - visibility.lastHiddenAt;
      visibility.lastHiddenAt = 0;
    }

    if (items.some((i) => i.state === 'laeuft')) void acquireWakeLock();
  });

  // Nach einer Unterbrechung sofort weitermachen, statt den Backoff
  // abzuwarten. Wer das Handy wieder in die Hand nimmt, soll nicht bis zu
  // 30 Sekunden auf gar nichts schauen.
  window.addEventListener('online', () => {
    for (const item of items) {
      if (item.state === 'laeuft' && item.upload) {
        item.note.textContent = 'Verbindung zurück – wird fortgesetzt …';
      }
    }
  });
}

/**
 * Haelt den Bildschirm wach.
 *
 * Sperrt sich der Bildschirm, friert iOS den Tab ein und der Upload steht -
 * ohne jede Rueckmeldung. Das ist eine der Hauptursachen fuer scheinbar
 * "haengende" Uploads.
 */
async function acquireWakeLock(): Promise<void> {
  if (wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    // Nicht unterstuetzt oder verweigert. Der Hinweis im Fuss bleibt die
    // Rueckfallebene.
    wakeLock = null;
  }
}

async function releaseWakeLock(): Promise<void> {
  try {
    await wakeLock?.release();
  } catch {
    /* egal */
  }
  wakeLock = null;
}

/**
 * Erkennt die eingebauten Browser von WhatsApp, Instagram und Facebook.
 * Dort ist die Dateiauswahl eingeschraenkt und Uploads brechen haeufiger ab -
 * ein Hinweis erspart viel Ratlosigkeit.
 */
function detectInAppBrowser(): void {
  const ua = navigator.userAgent;
  const inApp = /(FBAN|FBAV|Instagram|Line\/|WhatsApp|Snapchat)/i.test(ua);
  if (inApp) $('inapp').classList.remove('hidden');
}
