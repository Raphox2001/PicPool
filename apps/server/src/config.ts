import { z } from 'zod';
import path from 'node:path';
import { Buffer } from 'node:buffer';

/**
 * Konfiguration wird beim Start einmal validiert. Faellt etwas durch, bricht
 * der Prozess sofort ab - eine halb konfigurierte Instanz, die Uploads annimmt
 * und still verliert, waere schlimmer als gar keine.
 */

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const positiveInt = z.coerce.number().int().positive();

const cidrList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.string().regex(/^[0-9a-fA-F.:]+\/\d{1,3}$/, 'ungueltiges CIDR')));

const schema = z.object({
  PICPOOL_PORT: positiveInt.default(8080),
  PICPOOL_BIND: z.string().default('0.0.0.0'),

  PICPOOL_PUBLIC_URL: z
    .string()
    .url('PICPOOL_PUBLIC_URL muss eine vollstaendige URL sein')
    .refine((u) => !u.endsWith('/'), 'PICPOOL_PUBLIC_URL darf nicht auf / enden'),

  PICPOOL_TRUST_PROXY: cidrList.default(''),
  PICPOOL_LAN_CIDRS: cidrList.default(''),

  PICPOOL_DATA_DIR: z.string().min(1),

  // 32 Byte base64. Kuerzere Schluessel werden abgelehnt statt stillschweigend
  // aufgefuellt - ein zu kurzer Schluessel ist ein Sicherheitsfehler.
  PICPOOL_SECRET_KEY: z
    .string()
    .min(1, 'PICPOOL_SECRET_KEY fehlt (openssl rand -base64 32)')
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'PICPOOL_SECRET_KEY muss genau 32 Byte base64 sein'),

  PICPOOL_MAX_FILE_BYTES: positiveInt.default(5 * 1024 * 1024 * 1024),
  PICPOOL_MAX_IMAGE_PIXELS: positiveInt.default(200_000_000),
  PICPOOL_UPLOAD_RATE_PER_IP_PER_MIN: positiveInt.default(120),
  PICPOOL_LOGIN_RATE_PER_IP_PER_MIN: positiveInt.default(10),

  PICPOOL_WORKER_CONCURRENCY: positiveInt.max(8).default(2),
  PICPOOL_FFMPEG_PATH: z.string().default('ffmpeg'),
  PICPOOL_FFPROBE_PATH: z.string().default('ffprobe'),

  PICPOOL_THUMB_SIZE: positiveInt.default(320),
  PICPOOL_PREVIEW_SIZE: positiveInt.default(2048),

  // Nimmt beliebig grosse Daten entgegen - nur fuer die Fehlersuche.
  // Darf im Regelbetrieb NIEMALS an sein: waere ein offenes Datengrab.
  PICPOOL_NETTEST: bool.default('false'),

  PICPOOL_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

export type RawConfig = z.infer<typeof schema>;

function build() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Konfiguration ungueltig:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  const dataDir = path.resolve(env.PICPOOL_DATA_DIR);

  return {
    port: env.PICPOOL_PORT,
    bind: env.PICPOOL_BIND,
    publicUrl: env.PICPOOL_PUBLIC_URL,
    trustProxyCidrs: env.PICPOOL_TRUST_PROXY,
    lanCidrs: env.PICPOOL_LAN_CIDRS,
    logLevel: env.PICPOOL_LOG_LEVEL,
    netTestEnabled: env.PICPOOL_NETTEST,

    /** Alle Pfade leiten sich aus dem einen gemounteten Verzeichnis ab. */
    paths: {
      root: dataDir,
      originals: path.join(dataDir, 'originals'),
      derivatives: path.join(dataDir, 'derivatives'),
      incoming: path.join(dataDir, 'incoming'),
      db: path.join(dataDir, 'db', 'picpool.db'),
    },

    secretKey: Buffer.from(env.PICPOOL_SECRET_KEY, 'base64'),

    limits: {
      maxFileBytes: env.PICPOOL_MAX_FILE_BYTES,
      maxImagePixels: env.PICPOOL_MAX_IMAGE_PIXELS,
      uploadRatePerIpPerMin: env.PICPOOL_UPLOAD_RATE_PER_IP_PER_MIN,
      loginRatePerIpPerMin: env.PICPOOL_LOGIN_RATE_PER_IP_PER_MIN,
    },

    worker: {
      concurrency: env.PICPOOL_WORKER_CONCURRENCY,
      ffmpeg: env.PICPOOL_FFMPEG_PATH,
      ffprobe: env.PICPOOL_FFPROBE_PATH,
    },

    derivatives: {
      thumbSize: env.PICPOOL_THUMB_SIZE,
      previewSize: env.PICPOOL_PREVIEW_SIZE,
    },
  } as const;
}

export type Config = ReturnType<typeof build>;

let cached: Config | null = null;

export function getConfig(): Config {
  if (!cached) cached = build();
  return cached;
}
