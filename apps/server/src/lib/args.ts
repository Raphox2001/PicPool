/**
 * Argumente der Kommandozeile.
 *
 * Eigenes Modul, weil hier ein Fehler steckte, der teuer war: Der Befehl
 * `backup --behalten 14` las die `14` als Zielpfad, weil die freien Argumente
 * als "alles, was nicht mit -- anfaengt" bestimmt wurden. Die Sicherung sollte
 * dann in eine Datei namens "14" im Arbeitsverzeichnis gehen - im Container auf
 * dem schreibgeschuetzten Wurzeldateisystem. SQLite meldete dazu nur
 * "unable to open database file", was nach einem Rechteproblem an der
 * Datenbank aussieht und in die voellig falsche Richtung fuehrt.
 * Beobachtet am 30.09.2026 auf der NAS.
 *
 * Voraussetzung: Jeder Schalter dieser CLI hat einen Wert (`--anzahl 20`).
 * Kaeme einmal ein Schalter ohne Wert hinzu, muesste er hier bekannt sein -
 * sonst verschluckt er das naechste freie Argument.
 */

/** Wert eines Schalters, z.B. flag(args, 'anzahl') fuer `--anzahl 20`. */
export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Die freien Argumente - ohne die Schalter und ohne deren Werte. */
export function positionals(args: string[]): string[] {
  const out: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      // Der naechste Eintrag gehoert zu diesem Schalter, nicht zum Befehl.
      i++;
      continue;
    }
    out.push(a);
  }

  return out;
}
