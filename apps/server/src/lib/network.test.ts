import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isInCidrs, parseCidr } from './network.ts';

/**
 * Diese Pruefung entscheidet, wer Originalaufloesung sehen darf. Ein Fehler
 * hier waere ein Sicherheitsfehler, kein Schoenheitsfehler - deshalb ist sie
 * ausfuehrlich getestet.
 */

describe('isInCidrs (IPv4)', () => {
  const lan = ['192.168.1.0/24'];

  test('erkennt Adressen im Subnetz', () => {
    assert.ok(isInCidrs('192.168.1.1', lan));
    assert.ok(isInCidrs('192.168.1.255', lan));
  });

  test('weist Adressen ausserhalb ab', () => {
    assert.ok(!isInCidrs('192.168.2.1', lan));
    assert.ok(!isInCidrs('10.0.0.1', lan));
    assert.ok(!isInCidrs('8.8.8.8', lan));
  });

  test('beachtet die Praefixlaenge genau', () => {
    assert.ok(isInCidrs('10.1.2.3', ['10.1.2.0/24']));
    assert.ok(!isInCidrs('10.1.3.3', ['10.1.2.0/24']));
    assert.ok(isInCidrs('10.1.3.3', ['10.1.0.0/16']));
    // Ungerade Praefixlaengen sind der haeufigste Ort fuer Denkfehler
    assert.ok(isInCidrs('192.168.1.100', ['192.168.1.64/26']));
    assert.ok(!isInCidrs('192.168.1.200', ['192.168.1.64/26']));
  });

  test('/32 trifft genau eine Adresse', () => {
    assert.ok(isInCidrs('192.168.1.50', ['192.168.1.50/32']));
    assert.ok(!isInCidrs('192.168.1.51', ['192.168.1.50/32']));
  });

  test('mehrere Subnetze werden alle geprueft', () => {
    const list = ['10.0.0.0/8', '192.168.0.0/16'];
    assert.ok(isInCidrs('10.5.5.5', list));
    assert.ok(isInCidrs('192.168.99.1', list));
    assert.ok(!isInCidrs('172.16.0.1', list));
  });

  test('leere Liste erlaubt niemandem etwas', () => {
    assert.ok(!isInCidrs('192.168.1.1', []));
    assert.ok(!isInCidrs('127.0.0.1', []));
  });
});

describe('isInCidrs (IPv6 und Mischformen)', () => {
  test('erkennt IPv4-Adressen in IPv6-Schreibweise', () => {
    // So liefert Node die Adresse, wenn der Socket auf IPv6 lauscht.
    assert.ok(isInCidrs('::ffff:192.168.1.5', ['192.168.1.0/24']));
    assert.ok(!isInCidrs('::ffff:8.8.8.8', ['192.168.1.0/24']));
  });

  test('vergleicht IPv6-Subnetze', () => {
    assert.ok(isInCidrs('fd00::1', ['fd00::/8']));
    assert.ok(!isInCidrs('fe80::1', ['fd00::/8']));
  });

  test('vermischt IPv4 und IPv6 nicht', () => {
    assert.ok(!isInCidrs('fd00::1', ['192.168.1.0/24']));
    assert.ok(!isInCidrs('192.168.1.1', ['fd00::/8']));
  });
});

describe('Robustheit gegen Unsinn', () => {
  test('ungueltige Adressen gelten als fremd', () => {
    for (const bad of ['', 'abc', '999.1.1.1', '192.168.1', '192.168.1.1.1', '../etc']) {
      assert.ok(!isInCidrs(bad, ['192.168.1.0/24']), `${bad} wurde faelschlich akzeptiert`);
    }
  });

  test('ungueltige Subnetzangaben werden uebersprungen', () => {
    assert.equal(parseCidr('192.168.1.0/33'), null);
    assert.equal(parseCidr('192.168.1.0/-1'), null);
    assert.equal(parseCidr('192.168.1.0'), null);
    assert.equal(parseCidr('unsinn/24'), null);
    // Ein kaputter Eintrag darf einen gueltigen daneben nicht entwerten
    assert.ok(isInCidrs('192.168.1.5', ['unsinn/24', '192.168.1.0/24']));
  });
});
