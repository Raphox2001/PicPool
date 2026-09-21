import PhotoSwipeLightbox from 'photoswipe/lightbox';
import PhotoSwipe from 'photoswipe';
import { thumbHashToDataURL } from 'thumbhash';
import './style.css';

/**
 * Galerie fuer Gaeste.
 *
 * Zwei Dinge bestimmen den Aufbau:
 *
 *  - Geschwindigkeit. Das Raster laedt zuerst nur Thumbnails (~320px) und
 *    zeigt bis dahin einen unscharfen Platzhalter aus dem ThumbHash. Die
 *    hoeher aufgeloeste Fassung kommt erst beim Oeffnen der Lightbox, das
 *    Original ueberhaupt nur beim Herunterladen.
 *
 *  - Wiederfinden. Chronologisch nach Tagen gruppiert, zusaetzlich nach
 *    Person filterbar - das sind die beiden Fragen, die nach einem Event
 *    tatsaechlich gestellt werden.
 */

interface Asset {
  id: string;
  kind: 'image' | 'video';
  uploaderId: string | null;
  uploaderName: string | null;
  takenAt: string | null;
  takenAtSource: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbhash: string | null;
  originalFilename: string;
  bytes: number;
}

interface Uploader {
  id: string;
  name: string;
  count: number;
}

interface AlbumInfo {
  name: string;
  description: string | null;
  eventDate: string | null;
  assetCount: number;
  totalBytes: number;
  allowDownloads: boolean;
  originalsAvailable: boolean;
  onLan: boolean;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element fehlt: ${id}`);
  return el as T;
};

const token = /\/g\/([A-Za-z0-9_-]{10,64})/.exec(window.location.pathname)?.[1] ?? '';

let album: AlbumInfo | null = null;
let assets: Asset[] = [];
let uploaders: Uploader[] = [];
let filterUploaderId: string | null = null;
const selected = new Set<string>();

const mediaUrl = (id: string, variant: 'thumb' | 'preview' | 'original', download = false): string =>
  `/api/g/${token}/a/${id}/${variant}${download ? '?dl=1' : ''}`;

void init();

async function init(): Promise<void> {
  if (!token) return fail('Dieser Link ist unvollständig.');

  try {
    const res = await fetch(`/api/g/${token}`, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    if (!res.ok || !data.ok) return fail(data?.message ?? 'Dieser Link ist nicht gültig oder abgelaufen.');

    album = data.album as AlbumInfo;
    assets = data.assets as Asset[];
    uploaders = data.uploaders as Uploader[];
  } catch {
    return fail('Keine Verbindung zum Server.');
  }

  renderHeader();
  renderChips();
  renderGrid();
  setupSelection();
  setupLightbox();
}

function fail(message: string): void {
  $('album').textContent = 'Galerie';
  $('status').textContent = message;
  $('days').innerHTML = '';
}

// ---------------------------------------------------------------------------
// Kopfbereich
// ---------------------------------------------------------------------------

function renderHeader(): void {
  if (!album) return;

  $('album').textContent = album.name;
  document.title = `${album.name} – Galerie`;

  const parts: string[] = [];
  if (album.eventDate) parts.push(formatDate(album.eventDate));
  parts.push(`${album.assetCount} ${album.assetCount === 1 ? 'Datei' : 'Dateien'}`);
  if (album.originalsAvailable) parts.push(formatBytes(album.totalBytes));
  if (album.onLan && album.originalsAvailable) parts.push('volle Auflösung verfügbar');
  $('subtitle').textContent = parts.join(' · ');

  if (album.allowDownloads && assets.length > 0) {
    const btn = $<HTMLButtonElement>('dl-all');
    btn.classList.remove('hidden');
    btn.addEventListener('click', () => {
      // Der Filter gilt auch fuer den Sammel-Download: Wer nach einer Person
      // gefiltert hat, erwartet auch nur deren Bilder im Archiv.
      const q = filterUploaderId ? `?uploader=${encodeURIComponent(filterUploaderId)}` : '';
      window.location.href = `/api/g/${token}/zip${q}`;
    });
  }
}

function renderChips(): void {
  // Ein Filter ergibt erst ab zwei Personen Sinn.
  if (uploaders.length < 2) return;

  const nav = $('chips');
  nav.classList.remove('hidden');
  nav.innerHTML = '';

  const make = (id: string | null, label: string, count: number): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.setAttribute('aria-pressed', String(filterUploaderId === id));
    b.innerHTML = `${escapeHtml(label)}<span class="n">${count}</span>`;
    b.addEventListener('click', () => {
      filterUploaderId = filterUploaderId === id ? null : id;
      renderChips();
      renderGrid();
      updateDownloadAllLabel();
    });
    return b;
  };

  nav.appendChild(make(null, 'Alle', assets.length));
  for (const u of uploaders) nav.appendChild(make(u.id, u.name, u.count));
}

function updateDownloadAllLabel(): void {
  const btn = $<HTMLButtonElement>('dl-all');
  const person = uploaders.find((u) => u.id === filterUploaderId);
  btn.textContent = person ? `Bilder von ${person.name} laden` : 'Alle herunterladen';
}

// ---------------------------------------------------------------------------
// Raster
// ---------------------------------------------------------------------------

function visibleAssets(): Asset[] {
  return filterUploaderId ? assets.filter((a) => a.uploaderId === filterUploaderId) : assets;
}

function renderGrid(): void {
  const list = visibleAssets();
  const host = $('days');
  host.innerHTML = '';

  if (list.length === 0) {
    $('status').textContent = assets.length === 0
      ? 'Hier ist noch nichts. Sobald jemand hochlädt, erscheinen die Bilder hier.'
      : 'Von dieser Person ist noch nichts da.';
    return;
  }
  $('status').classList.add('hidden');

  for (const [day, group] of groupByDay(list)) {
    const head = document.createElement('h2');
    head.className = 'day-head';
    head.textContent = day;
    host.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const asset of group) grid.appendChild(makeTile(asset));
    host.appendChild(grid);
  }
}

/**
 * Gruppiert nach Kalendertag.
 *
 * Grundlage ist der Aufnahmezeitpunkt aus den EXIF-Daten. Wo der fehlt, wurde
 * serverseitig auf das Dateidatum zurueckgegriffen; solche Dateien landen
 * dadurch am richtigen Ort, wenn auch mit etwas weniger Gewissheit.
 */
function groupByDay(list: Asset[]): Array<[string, Asset[]]> {
  const map = new Map<string, Asset[]>();
  for (const a of list) {
    const key = a.takenAt ? a.takenAt.slice(0, 10) : 'ohne-datum';
    const arr = map.get(key);
    if (arr) arr.push(a);
    else map.set(key, [a]);
  }
  return [...map.entries()].map(([key, arr]) => [
    key === 'ohne-datum' ? 'Ohne Datum' : formatDate(key),
    arr,
  ]);
}

function makeTile(asset: Asset): HTMLElement {
  const tile = document.createElement('button');
  tile.className = 'tile';
  tile.type = 'button';
  tile.dataset.id = asset.id;
  tile.setAttribute('aria-selected', String(selected.has(asset.id)));
  tile.setAttribute(
    'aria-label',
    `${asset.kind === 'video' ? 'Video' : 'Foto'}${asset.uploaderName ? ` von ${asset.uploaderName}` : ''}`,
  );

  // Der unscharfe Platzhalter steht sofort, ohne einen einzigen Netzabruf.
  const placeholder = thumbhashUrl(asset.thumbhash);
  if (placeholder) tile.style.backgroundImage = `url(${placeholder})`;

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  img.src = mediaUrl(asset.id, 'thumb');
  img.addEventListener('load', () => img.classList.add('geladen'));
  tile.appendChild(img);

  if (asset.kind === 'video') {
    const play = document.createElement('span');
    play.className = 'play';
    play.textContent = '▶';
    tile.appendChild(play);

    if (asset.durationMs) {
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = formatDuration(asset.durationMs);
      tile.appendChild(dur);
    }
  }

  if (album?.allowDownloads) {
    const pick = document.createElement('span');
    pick.className = 'pick';
    pick.textContent = selected.has(asset.id) ? '✓' : '';
    tile.appendChild(pick);
  }

  return tile;
}

function thumbhashUrl(hash: string | null): string | null {
  if (!hash) return null;
  try {
    const bin = atob(hash);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return thumbHashToDataURL(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auswahl
// ---------------------------------------------------------------------------

/**
 * Mehrfachauswahl ueber langes Druecken.
 *
 * Ein kurzer Tipp oeffnet das Bild - das ist die Erwartung. Erst ein langer
 * Druck schaltet in die Auswahl; danach genuegt ein Tipp, solange etwas
 * ausgewaehlt ist.
 */
function setupSelection(): void {
  if (!album?.allowDownloads) return;

  const host = $('days');
  let longPressTimer: number | undefined;
  let longPressed = false;

  host.addEventListener('pointerdown', (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile');
    if (!tile) return;
    longPressed = false;
    longPressTimer = window.setTimeout(() => {
      longPressed = true;
      toggleSelect(tile);
      // Kurze Rueckmeldung, damit der Moduswechsel spuerbar ist.
      navigator.vibrate?.(30);
    }, 450);
  });

  const cancel = (): void => window.clearTimeout(longPressTimer);
  host.addEventListener('pointerup', cancel);
  host.addEventListener('pointercancel', cancel);
  host.addEventListener('pointermove', cancel);

  host.addEventListener(
    'click',
    (e) => {
      const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile');
      if (!tile) return;
      if (longPressed) {
        e.stopPropagation();
        e.preventDefault();
        longPressed = false;
        return;
      }
      if (selected.size > 0) {
        e.stopPropagation();
        e.preventDefault();
        toggleSelect(tile);
      }
    },
    true,
  );

  $('sel-clear').addEventListener('click', () => {
    selected.clear();
    document.querySelectorAll<HTMLElement>('.tile[aria-selected="true"]').forEach((t) => {
      t.setAttribute('aria-selected', 'false');
      const p = t.querySelector('.pick');
      if (p) p.textContent = '';
    });
    renderSelBar();
  });

  $('sel-dl').addEventListener('click', () => {
    if (selected.size === 0) return;
    window.location.href = `/api/g/${token}/zip?ids=${[...selected].join(',')}`;
  });
}

function toggleSelect(tile: HTMLElement): void {
  const id = tile.dataset.id;
  if (!id) return;

  if (selected.has(id)) selected.delete(id);
  else selected.add(id);

  tile.setAttribute('aria-selected', String(selected.has(id)));
  const pick = tile.querySelector('.pick');
  if (pick) pick.textContent = selected.has(id) ? '✓' : '';
  renderSelBar();
}

function renderSelBar(): void {
  const bar = $('selbar');
  if (selected.size === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  $('sel-count').textContent = `${selected.size} ausgewählt`;
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

function setupLightbox(): void {
  const lightbox = new PhotoSwipeLightbox({
    gallery: '#days',
    children: '.tile',
    pswpModule: () => Promise.resolve({ default: PhotoSwipe }),
    bgOpacity: 0.95,
    showHideAnimationType: 'zoom',
  });

  // PhotoSwipe kennt unsere Daten nicht aus dem Markup - die Masse und die
  // Adresse der Vorschau kommen aus dem Datenbestand.
  lightbox.addFilter('itemData', (_item, index) => {
    const asset = visibleAssets()[index];
    if (!asset) return {};

    if (asset.kind === 'video') {
      return {
        type: 'video',
        assetId: asset.id,
        width: asset.width ?? 1280,
        height: asset.height ?? 720,
        msrc: mediaUrl(asset.id, 'thumb'),
      } as never;
    }

    return {
      src: mediaUrl(asset.id, 'preview'),
      width: asset.width ?? 2048,
      height: asset.height ?? 2048,
      msrc: mediaUrl(asset.id, 'thumb'),
      alt: asset.uploaderName ? `Foto von ${asset.uploaderName}` : 'Foto',
    } as never;
  });

  // Videos bekommen statt eines Bildes ein Abspielelement.
  lightbox.on('contentLoad', (e) => {
    const { content } = e;
    const data = content.data as unknown as { type?: string; assetId?: string };
    if (data.type !== 'video' || !data.assetId) return;

    e.preventDefault();
    const video = document.createElement('video');
    video.className = 'pswp__video';
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.poster = mediaUrl(data.assetId, 'preview');
    video.src = mediaUrl(data.assetId, 'original');
    // PhotoSwipe typisiert element enger, als es zur Laufzeit zulaesst;
    // ein Videoelement ist dort ausdruecklich vorgesehen.
    (content as unknown as { element: HTMLElement }).element = video;
  });

  // Ein angehaltenes Video soll nicht im Hintergrund weiterlaufen.
  lightbox.on('contentDeactivate', (e) => {
    const el = e.content.element;
    if (el instanceof HTMLVideoElement) el.pause();
  });

  // Schaltflaeche zum Herunterladen der Originaldatei.
  if (album?.originalsAvailable) {
    lightbox.on('uiRegister', () => {
      lightbox.pswp?.ui?.registerElement({
        name: 'download',
        order: 8,
        isButton: true,
        tagName: 'a',
        html: '⤓',
        onInit: (el, pswp) => {
          const anchor = el as HTMLAnchorElement;
          anchor.setAttribute('download', '');
          anchor.setAttribute('target', '_blank');
          anchor.setAttribute('rel', 'noopener');
          anchor.title = 'Original herunterladen';
          pswp.on('change', () => {
            const asset = visibleAssets()[pswp.currIndex];
            if (asset) anchor.href = mediaUrl(asset.id, 'original', true);
          });
        },
      });
    });
  }

  // Wer etwas ausgewaehlt hat, will tippend weiter auswaehlen statt oeffnen.
  lightbox.addFilter('clickedIndex', (index) => (selected.size > 0 ? -1 : index));

  lightbox.init();
}

// ---------------------------------------------------------------------------
// Formatierung
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
