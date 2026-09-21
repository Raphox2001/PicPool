/**
 * Zugriff auf die Verwaltungs-API.
 *
 * Alle veraendernden Anfragen tragen das CSRF-Token der Sitzung im Header.
 * Das Token kommt bei der Anmeldung zurueck und wird hier gehalten, nicht im
 * localStorage - so verschwindet es beim Schliessen des Tabs, und ein
 * eingeschleustes Skript kommt nicht ueber die Speicher-API daran.
 */

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['X-PicPool-CSRF'] = csrfToken;

  const res = await fetch(`/api/admin${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // Das Sitzungscookie ist HttpOnly; der Browser schickt es mit.
    credentials: 'same-origin',
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keine JSON-Antwort */
  }

  if (!res.ok) {
    const message =
      (data as { message?: string } | null)?.message ?? `Fehler ${res.status}`;
    throw new ApiError(res.status, message);
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body ?? {}),
};

// ---------------------------------------------------------------------------
// Datentypen
// ---------------------------------------------------------------------------

export interface ShareLinkInfo {
  id: string;
  kind: 'upload' | 'gallery';
  label: string | null;
  url: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  useCount: number;
  lastUsedAt: string | null;
}

export interface AlbumSettings {
  allowDownloads: boolean;
  allowOriginalsOnLan: boolean;
  stripGps: boolean;
  transcodeVideos: boolean;
  maxFiles: number | null;
  maxBytes: number | null;
}

export interface AlbumSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  eventDate: string | null;
  createdAt: string;
  archivedAt: string | null;
  files: number;
  bytes: number;
  settings: AlbumSettings;
  links: ShareLinkInfo[];
}

export interface AdminAsset {
  id: string;
  kind: 'image' | 'video';
  uploaderName: string | null;
  takenAt: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  originalFilename: string;
  bytes: number;
  videoCodec: string | null;
  hasH264: number;
}

export interface UploaderInfo {
  id: string;
  name: string;
  count: number;
}

export interface Overview {
  albums: number;
  files: number;
  bytes: number;
  failedAssets: number;
  jobs: Record<string, number>;
  recentUploadErrors: Array<{
    at: string;
    filename?: string;
    message?: string;
    context?: string;
  }>;
}

export interface AdminState {
  setupNeeded: boolean;
  loggedIn: boolean;
  user: { username: string; totpEnabled: boolean; lastLoginAt: string | null } | null;
  csrfToken: string | null;
}

// ---------------------------------------------------------------------------
// Formatierung
// ---------------------------------------------------------------------------

export function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
