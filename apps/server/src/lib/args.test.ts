import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { flag, positionals } from './args.js';

describe('Schalter lesen', () => {
  test('liefert den Wert hinter dem Schalter', () => {
    assert.equal(flag(['--anzahl', '20'], 'anzahl'), '20');
    assert.equal(flag(['album', '--behalten', '14'], 'behalten'), '14');
  });

  test('liefert undefined, wenn der Schalter fehlt', () => {
    assert.equal(flag(['album'], 'anzahl'), undefined);
  });
});

describe('Freie Argumente', () => {
  test('der Wert eines Schalters ist kein freies Argument', () => {
    // Der Fehler vom 30.09.2026: Hier wurde "14" als Zielpfad der Sicherung
    // gelesen, und die landete dann im schreibgeschuetzten
    // Wurzeldateisystem des Containers.
    assert.deepEqual(positionals(['--behalten', '14']), []);
  });

  test('freie Argumente bleiben in ihrer Reihenfolge', () => {
    assert.deepEqual(positionals(['sommerfest', 'upload']), ['sommerfest', 'upload']);
  });

  test('Schalter vor, zwischen und nach den freien Argumenten', () => {
    assert.deepEqual(
      positionals(['--datum', '2026-07-14', 'sommerfest', '--max-gb', '50', 'upload']),
      ['sommerfest', 'upload'],
    );
  });

  test('ein angegebener Zielpfad bleibt erhalten', () => {
    assert.deepEqual(positionals(['/volume1/picpool/backups/vor-umzug.db', '--behalten', '3']), [
      '/volume1/picpool/backups/vor-umzug.db',
    ]);
  });

  test('ohne Argumente kommt nichts heraus', () => {
    assert.deepEqual(positionals([]), []);
  });
});
