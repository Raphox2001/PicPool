import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import { needsFfmpegDecode } from '@picpool/shared';
import { getConfig } from '../config.js';

/**
 * HEIC-Dekodierung
 * ================
 * Die vorgebauten sharp/libvips-Binaries enthalten libheif OHNE HEVC-Decoder
 * (Patentlizenzierung). Verifiziert am 2026-09-21: sharp liest die Metadaten
 * einer HEVC-HEIC problemlos und meldet sogar compression="hevc", scheitert
 * aber bei der Pixel-Dekodierung mit "bad seek". AVIF/AV1 funktioniert dagegen.
 *
 * Das ist die gefaehrlichste Variante eines Fehlers: metadata() meldet Erfolg.
 * Wer nur darauf prueft, merkt erst in Produktion, dass jedes iPhone-Foto
 * fehlschlaegt - und iPhones liefern HEVC-HEIC.
 *
 * Deshalb wird HEIC ueber ffmpeg dekodiert, das ohnehin fuer Videos gebraucht
 * wird. Zwischenformat ist MJPEG: gemessen schneller als PNG und bei 12 MP nur
 * rund 5 MB Puffer statt 35 MB bei raw rgb24, bei praktisch identischem
 * WebP-Endergebnis. Das Original bleibt unangetastet.
 */

const FFMPEG_TIMEOUT_MS = 120_000;

export class MediaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MediaError';
  }
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/**
 * Startet ein externes Binary und sammelt stdout.
 *
 * Der Timeout ist nicht optional: eine praeparierte Datei darf den Worker
 * nicht dauerhaft blockieren.
 */
function run(bin: string, args: string[], timeoutMs = FFMPEG_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new MediaError(`${bin} Zeitueberschreitung nach ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new MediaError(`${bin} konnte nicht gestartet werden: ${e.message}`, { cause: e }));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr });
      else reject(new MediaError(`${bin} beendet mit Code ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

/** Dekodiert eine HEIC/HEIF-Datei ueber ffmpeg zu einem JPEG-Puffer. */
export async function decodeHeicToJpeg(filePath: string): Promise<Buffer> {
  const cfg = getConfig();
  const { stdout } = await run(cfg.worker.ffmpeg, [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', filePath,
    '-frames:v', '1',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', '2',
    '-',
  ]);

  if (stdout.length === 0) throw new MediaError('ffmpeg lieferte keine Bilddaten');
  return stdout;
}

/**
 * Liefert eine sharp-Instanz fuer ein Bild, unabhaengig vom Quellformat.
 * HEIC nimmt den ffmpeg-Umweg, alles andere geht direkt in sharp.
 */
export async function openImage(filePath: string, mime: string): Promise<sharp.Sharp> {
  const cfg = getConfig();

  const options: sharp.SharpOptions = {
    // Begrenzt den Speicherverbrauch beim Dekodieren. Schuetzt gegen
    // Decompression-Bombs, also Dateien, die komprimiert winzig sind und
    // entpackt den Arbeitsspeicher sprengen.
    limitInputPixels: cfg.limits.maxImagePixels,
    failOn: 'error',
  };

  if (needsFfmpegDecode(mime)) {
    return sharp(await decodeHeicToJpeg(filePath), options);
  }
  return sharp(filePath, options);
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

export interface VideoInfo {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  codec: string | null;
  /** EXIF-artiges Aufnahmedatum aus den Container-Tags, falls vorhanden. */
  creationTime: string | null;
  /** Drehung aus den Display-Matrix-Metadaten; Handys speichern hier die Lage. */
  rotation: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  side_data_list?: Array<{ rotation?: number }>;
  tags?: Record<string, string>;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; tags?: Record<string, string> };
}

export async function probeVideo(filePath: string): Promise<VideoInfo> {
  const cfg = getConfig();
  const { stdout } = await run(
    cfg.worker.ffprobe,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ],
    60_000,
  );

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout.toString('utf8')) as FfprobeOutput;
  } catch {
    throw new MediaError('ffprobe lieferte kein gueltiges JSON');
  }

  const video = parsed.streams?.find((s) => s.codec_type === 'video');
  if (!video) throw new MediaError('Datei enthaelt keine Videospur');

  const durationSec = Number(video.duration ?? parsed.format?.duration ?? NaN);

  // Hochkant gefilmte Handyvideos tragen die Drehung in den Metadaten, nicht
  // in den Pixeln. Ohne Beruecksichtigung stuenden sie in der Galerie quer.
  const rawRotation = video.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? 0;
  const rotation = ((Math.round(rawRotation) % 360) + 360) % 360;

  const swapped = rotation === 90 || rotation === 270;

  return {
    width: swapped ? (video.height ?? null) : (video.width ?? null),
    height: swapped ? (video.width ?? null) : (video.height ?? null),
    durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null,
    codec: video.codec_name ?? null,
    creationTime:
      video.tags?.creation_time ?? parsed.format?.tags?.creation_time ?? null,
    rotation,
  };
}

/**
 * Zieht ein Standbild aus dem Video als Vorschaubild.
 *
 * Gesucht wird bei 10 Prozent der Laufzeit statt bei Sekunde 0: der erste
 * Frame ist bei Handyvideos oft noch schwarz oder verwackelt.
 */
export async function extractPosterFrame(filePath: string, durationMs: number | null): Promise<Buffer> {
  const cfg = getConfig();
  const seekSec = durationMs && durationMs > 3000 ? Math.min(durationMs * 0.1, 10_000) / 1000 : 0;

  const { stdout } = await run(cfg.worker.ffmpeg, [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', seekSec.toFixed(2),
    '-i', filePath,
    '-frames:v', '1',
    // Die Display-Matrix wird beim Dekodieren angewandt, damit hochkant
    // gefilmte Videos ein hochkantes Vorschaubild bekommen.
    '-vf', 'scale=iw:ih',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', '2',
    '-',
  ]);

  if (stdout.length === 0) throw new MediaError('Kein Vorschaubild aus dem Video zu gewinnen');
  return stdout;
}

// ---------------------------------------------------------------------------
// H.264-Fallback
// ---------------------------------------------------------------------------

/**
 * Codecs, die verbreitet Probleme machen.
 *
 * HEVC ist der wichtigste Fall: iPhones nehmen standardmaessig so auf,
 * Safari spielt es ab, Firefox nicht und Chrome nur je nach Geraet. AV1 und
 * VP9 in MP4-Containern sind seltener, aber gleich gelagert.
 *
 * H.264 laeuft dagegen praktisch ueberall - deshalb ist es das Ziel.
 */
const PROBLEMATIC_CODECS = new Set(['hevc', 'h265', 'av1', 'vp9', 'vp8', 'mpeg4', 'msmpeg4v3']);

export function needsH264Fallback(codec: string | null): boolean {
  if (!codec) return false;
  return PROBLEMATIC_CODECS.has(codec.toLowerCase());
}

export interface TranscodeOptions {
  /** Laengste Kante der Ausgabe. Daruber wird verkleinert. */
  maxEdge?: number;
  /** Abbruch, wenn es laenger dauert. Schuetzt vor Endlosarbeit. */
  timeoutMs?: number;
}

/**
 * Erzeugt eine H.264-Fassung.
 *
 * Die Einstellungen sind auf die DS923+ zugeschnitten. Der Ryzen R1600 hat
 * keine iGPU, also keinerlei Hardware-Unterstuetzung - jede Umwandlung ist
 * reine Rechenarbeit auf zwei Kernen.
 *
 * Deshalb:
 *  - preset veryfast statt medium. Die Datei wird etwas groesser, aber die
 *    Umwandlung dauert einen Bruchteil. Bei einem Vorschauvideo zaehlt Tempo
 *    mehr als die letzten Prozent Kompression.
 *  - Begrenzung auf 1280 px laengste Kante. Es geht um Abspielbarkeit im
 *    Browser, nicht um Archivqualitaet - das Original bleibt unangetastet.
 *  - threads 2, damit der Worker die NAS nicht vollstaendig auslastet und
 *    daneben noch Uploads angenommen werden koennen.
 *  - faststart, damit die Wiedergabe beginnt, bevor die Datei ganz geladen ist.
 */
export async function transcodeToH264(
  inputPath: string,
  outputPath: string,
  opts: TranscodeOptions = {},
): Promise<void> {
  const cfg = getConfig();
  const maxEdge = opts.maxEdge ?? 1280;

  await run(
    cfg.worker.ffmpeg,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      // Nur verkleinern, nie vergroessern; gerade Kantenlaengen, weil
      // H.264 mit ungeraden Werten nicht umgehen kann.
      '-vf', `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '26',
      '-profile:v', 'high',
      '-level', '4.0',
      // yuv420p ist die Variante, die wirklich jeder Browser versteht.
      '-pix_fmt', 'yuv420p',
      '-threads', '2',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      // Verschiebt den Index an den Dateianfang.
      '-movflags', '+faststart',
      // Format ausdruecklich angeben. Geschrieben wird unter einem
      // Zwischennamen mit der Endung .part, und daraus kann ffmpeg das
      // Ausgabeformat nicht ableiten - es bricht sonst mit "Unable to choose
      // an output format" ab.
      '-f', 'mp4',
      outputPath,
    ],
    opts.timeoutMs ?? 30 * 60_000,
  );
}

// ---------------------------------------------------------------------------
// Selbsttest
// ---------------------------------------------------------------------------

export interface MediaCapabilities {
  ffmpeg: boolean;
  ffprobe: boolean;
  hevcDecoder: boolean;
  ffmpegVersion: string | null;
}

/**
 * Prueft beim Start, ob die Medien-Toolchain wirklich kann, was sie koennen
 * muss. Fehlt der HEVC-Decoder, laufen alle iPhone-Uploads ins Leere - das
 * soll beim Start laut auffallen und nicht erst beim ersten echten Gast.
 */
export async function probeCapabilities(): Promise<MediaCapabilities> {
  const cfg = getConfig();
  const caps: MediaCapabilities = {
    ffmpeg: false,
    ffprobe: false,
    hevcDecoder: false,
    ffmpegVersion: null,
  };

  try {
    const { stdout } = await run(cfg.worker.ffmpeg, ['-hide_banner', '-version'], 15_000);
    caps.ffmpeg = true;
    caps.ffmpegVersion = stdout.toString('utf8').split('\n')[0]?.trim() ?? null;
  } catch {
    return caps;
  }

  try {
    await run(cfg.worker.ffprobe, ['-hide_banner', '-version'], 15_000);
    caps.ffprobe = true;
  } catch {
    /* ffprobe fehlt - wird unten gemeldet */
  }

  try {
    const { stdout } = await run(cfg.worker.ffmpeg, ['-hide_banner', '-decoders'], 15_000);
    caps.hevcDecoder = /^\s*V[.A-Z]*\s+hevc\s/m.test(stdout.toString('utf8'));
  } catch {
    /* bleibt false */
  }

  return caps;
}

/** Formuliert die Befunde als Klartext-Warnungen fuer das Log. */
export function capabilityWarnings(caps: MediaCapabilities): string[] {
  const w: string[] = [];
  if (!caps.ffmpeg) {
    w.push('ffmpeg nicht gefunden - Videos und HEIC/iPhone-Fotos koennen NICHT verarbeitet werden.');
  }
  if (!caps.ffprobe) {
    w.push('ffprobe nicht gefunden - Video-Metadaten (Dauer, Masse) fehlen.');
  }
  if (caps.ffmpeg && !caps.hevcDecoder) {
    w.push(
      'ffmpeg hat keinen HEVC-Decoder - HEIC-Fotos von iPhones schlagen fehl. ' +
        'sharp allein kann das NICHT auffangen.',
    );
  }
  return w;
}
