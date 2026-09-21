-- PicPool Grundschema
-- Zeitstempel durchgaengig als ISO-8601 UTC-Text, z.B. 2026-09-21T14:30:00.000Z

-- ---------------------------------------------------------------------------
-- Alben
-- ---------------------------------------------------------------------------
CREATE TABLE albums (
  id                      TEXT PRIMARY KEY,
  slug                    TEXT NOT NULL UNIQUE,
  name                    TEXT NOT NULL,
  description             TEXT,
  event_date              TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  archived_at             TEXT,

  -- Einstellungen
  allow_downloads         INTEGER NOT NULL DEFAULT 1,
  allow_originals_on_lan  INTEGER NOT NULL DEFAULT 1,
  strip_gps               INTEGER NOT NULL DEFAULT 1,
  max_bytes               INTEGER,
  max_files               INTEGER,
  cover_asset_id          TEXT,

  CHECK (allow_downloads IN (0,1)),
  CHECK (allow_originals_on_lan IN (0,1)),
  CHECK (strip_gps IN (0,1))
);

-- ---------------------------------------------------------------------------
-- Share-Links
--
-- Das Klartext-Token wird NICHT gespeichert. Gespeichert werden:
--   token_hash  - SHA-256, fuer den indizierten Lookup beim Aufruf
--   token_enc   - AES-256-GCM mit PICPOOL_SECRET_KEY, damit der QR-Code
--                 spaeter erneut angezeigt werden kann
-- Ein gestohlenes Datenbank-Backup allein liefert damit keine gueltigen Links,
-- solange der Schluessel nicht im selben Backup liegt.
-- ---------------------------------------------------------------------------
CREATE TABLE share_links (
  id            TEXT PRIMARY KEY,
  album_id      TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('upload','gallery')),
  token_hash    TEXT NOT NULL UNIQUE,
  token_enc     TEXT NOT NULL,
  label         TEXT,
  pin_hash      TEXT,
  expires_at    TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  use_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_share_links_album ON share_links(album_id, kind);

-- ---------------------------------------------------------------------------
-- Uploader - eine Person, die in ein Album hochgeladen hat
-- ---------------------------------------------------------------------------
CREATE TABLE uploaders (
  id              TEXT PRIMARY KEY,
  album_id        TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  slug            TEXT NOT NULL,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  UNIQUE (album_id, name_normalized)
);

-- ---------------------------------------------------------------------------
-- Assets
-- ---------------------------------------------------------------------------
CREATE TABLE assets (
  id                 TEXT PRIMARY KEY,
  album_id           TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  uploader_id        TEXT REFERENCES uploaders(id) ON DELETE SET NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('image','video')),

  original_path      TEXT NOT NULL,      -- relativ zum Datenverzeichnis
  original_filename  TEXT NOT NULL,
  mime               TEXT NOT NULL,
  bytes              INTEGER NOT NULL,
  content_hash       TEXT NOT NULL,      -- SHA-256, fuer Deduplizierung

  width              INTEGER,
  height             INTEGER,
  duration_ms        INTEGER,
  orientation        INTEGER,
  thumbhash          TEXT,

  -- Chronologie: EXIF bevorzugt, sonst Dateidatum, sonst Uploadzeit.
  -- Die Quelle wird mitgefuehrt, damit die Galerie unsichere Daten kennzeichnen
  -- und der Admin den Uhrzeit-Versatz einzelner Kameras korrigieren kann.
  taken_at           TEXT,
  taken_at_source    TEXT CHECK (taken_at_source IN ('exif','mtime','upload')),

  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','processing','ready','failed')),
  error              TEXT,

  created_at         TEXT NOT NULL,
  processed_at       TEXT,
  deleted_at         TEXT
);

-- Deduplizierung pro Album: dieselbe Datei erscheint genau einmal.
-- Partiell, damit ein geloeschtes Asset einen erneuten Upload nicht blockiert.
CREATE UNIQUE INDEX idx_assets_dedupe
  ON assets(album_id, content_hash) WHERE deleted_at IS NULL;

CREATE INDEX idx_assets_chrono   ON assets(album_id, taken_at)    WHERE deleted_at IS NULL;
CREATE INDEX idx_assets_uploader ON assets(album_id, uploader_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_assets_status   ON assets(status)                WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Derivate
-- ---------------------------------------------------------------------------
CREATE TABLE derivatives (
  id          TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  variant     TEXT NOT NULL CHECK (variant IN ('thumb','preview','poster','video_h264')),
  path        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  created_at  TEXT NOT NULL,
  UNIQUE (asset_id, variant)
);

-- ---------------------------------------------------------------------------
-- Upload-Sessions - ein Browser-Besuch auf der Upload-Seite
-- ---------------------------------------------------------------------------
CREATE TABLE upload_sessions (
  id              TEXT PRIMARY KEY,
  share_link_id   TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  uploader_id     TEXT REFERENCES uploaders(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  ip_hash         TEXT,               -- gehasht, nicht im Klartext
  user_agent      TEXT,
  bytes_uploaded  INTEGER NOT NULL DEFAULT 0,
  files_uploaded  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_upload_sessions_link ON upload_sessions(share_link_id);

-- ---------------------------------------------------------------------------
-- Job-Queue
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL,          -- JSON
  priority      INTEGER NOT NULL DEFAULT 100,
  state         TEXT NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued','running','done','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  last_error    TEXT,
  run_after     TEXT NOT NULL,
  locked_at     TEXT,
  locked_by     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_jobs_pickup ON jobs(state, priority, run_after);

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------
CREATE TABLE admin_users (
  id                  TEXT PRIMARY KEY,
  username            TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,      -- argon2id
  totp_secret_enc     TEXT,               -- AES-256-GCM, erst nach Aktivierung
  totp_enabled        INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0,1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  last_login_at       TEXT,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,       -- gehashtes Session-Token
  user_id       TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Audit-Log
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor        TEXT,                    -- admin-username, guest oder system
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  ip           TEXT,
  detail       TEXT                     -- JSON
);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id);
