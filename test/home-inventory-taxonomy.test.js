/**
 * Modul: 家庭库存 — Taxonomie/Konsistenz-Test
 * Zweck: Die drei Stellen, die dieselbe Liste kennen müssen, dürfen nicht
 *        auseinanderlaufen: die Konstanten in public/utils/home-inventory-taxonomy.js,
 *        die Anzeige-Keys in den Sprachdateien und die daraus gebauten Auswahlfelder.
 *        Ein fehlender i18n-Key zeigt im Formular den rohen Schlüssel an
 *        ("homeInventory.cat.cleaning") — genau der Fehler aus 0.0.70.
 *
 * Aufruf: npm test  (node --test test/*.test.js)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  HOME_INVENTORY_CATEGORIES,
  HOME_INVENTORY_UNITS,
  HOME_INVENTORY_LOCATIONS,
  HOME_ITEM_TEMPLATES,
  isValidHomeCategory,
  isValidHomeUnit,
  isValidHomeLocation,
  isValidHomeDateKey,
  normalizeHomeBarcode,
  homeDaysLeft,
  addHomeDays,
  homeItemStatus,
  compareHomeBatches,
} from '../public/utils/home-inventory-taxonomy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const locale = (code) => JSON.parse(readFileSync(join(ROOT, 'public/locales', `${code}.json`), 'utf8'));

test('jede feste Kategorie hat einen Text in zh und en', () => {
  for (const code of ['zh', 'en']) {
    const node = locale(code).homeInventory?.cat ?? {};
    for (const { key } of HOME_INVENTORY_CATEGORIES) {
      assert.ok(node[key], `${code}: homeInventory.cat.${key} fehlt`);
    }
  }
});

test('jede feste Einheit hat einen Text in zh und en', () => {
  for (const code of ['zh', 'en']) {
    const node = locale(code).homeInventory?.unit ?? {};
    for (const key of HOME_INVENTORY_UNITS) {
      assert.ok(node[key], `${code}: homeInventory.unit.${key} fehlt`);
    }
  }
});

test('jeder feste Lagerort hat einen Text in zh und en', () => {
  for (const code of ['zh', 'en']) {
    const node = locale(code).homeInventory?.loc ?? {};
    for (const key of HOME_INVENTORY_LOCATIONS) {
      assert.ok(node[key], `${code}: homeInventory.loc.${key} fehlt`);
    }
  }
});

test('jedes Template hat einen Text und nur bekannte Verweise', () => {
  const zh = locale('zh').homeInventory?.tpl ?? {};
  for (const tpl of HOME_ITEM_TEMPLATES) {
    assert.ok(zh[tpl.key], `homeInventory.tpl.${tpl.key} fehlt`);
    assert.ok(isValidHomeCategory(tpl.category), `${tpl.key}: unbekannte Kategorie ${tpl.category}`);
    assert.ok(isValidHomeUnit(tpl.unit), `${tpl.key}: unbekannte Einheit ${tpl.unit}`);
    assert.ok(!tpl.location || isValidHomeLocation(tpl.location), `${tpl.key}: unbekannter Ort ${tpl.location}`);
  }
});

test('Template-Schlüssel sind eindeutig', () => {
  const keys = HOME_ITEM_TEMPLATES.map((tpl) => tpl.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('Datumsprüfung kennt den Kalender, nicht nur das Muster', () => {
  assert.equal(isValidHomeDateKey('2026-02-28'), true);
  assert.equal(isValidHomeDateKey('2026-02-30'), false);
  assert.equal(isValidHomeDateKey('2026-13-01'), false);
  assert.equal(isValidHomeDateKey('2026-1-1'), false);
  assert.equal(isValidHomeDateKey(''), false);
});

test('addHomeDays rechnet über Monats- und Jahresgrenzen', () => {
  assert.equal(addHomeDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addHomeDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addHomeDays('2026-03-01', -1), '2026-02-28');
});

test('Barcode nimmt EAN/QR, weist Unsinn ab', () => {
  assert.equal(normalizeHomeBarcode(' 6901234567892 '), '6901234567892');
  assert.equal(normalizeHomeBarcode('ABC-1234'), 'ABC-1234');
  assert.equal(normalizeHomeBarcode('12'), '');
  assert.equal(normalizeHomeBarcode('https://example.com/x'), '');
});

test('Resttage: ohne Verbrauch keine Prognose', () => {
  assert.equal(homeDaysLeft(10, 2), 5);
  assert.equal(homeDaysLeft(10, null), null);
  assert.equal(homeDaysLeft(10, 0), null);
  assert.equal(homeDaysLeft(0, 2), 0);
});

test('Status: leer, knapp, abgelaufen, bald', () => {
  const today = '2026-06-01';
  assert.deepEqual(
    homeItemStatus({ quantity: 0, min_quantity: 1 }, today),
    { out: true, low: false, expiry: null, days: null },
  );
  assert.equal(homeItemStatus({ quantity: 1, min_quantity: 2 }, today).low, true);
  assert.equal(homeItemStatus({ quantity: 3, min_quantity: 2 }, today).low, false);
  assert.equal(homeItemStatus({ quantity: 1, expires_on: '2026-05-31' }, today).expiry, 'expired');
  assert.equal(homeItemStatus({ quantity: 1, expires_on: '2026-06-20' }, today).expiry, 'soon');
  assert.equal(homeItemStatus({ quantity: 1, expires_on: '2027-06-20' }, today).expiry, null);
});

test('Batch-Reihenfolge: Name, dann MHD, dann id', () => {
  const rows = [
    { id: 3, name: 'B', expires_on: '2027-01-01' },
    { id: 2, name: 'A', expires_on: null },
    { id: 1, name: 'A', expires_on: '2026-01-01' },
  ];
  const sorted = [...rows].sort(compareHomeBatches);
  assert.deepEqual(sorted.map((r) => r.id), [1, 2, 3]);
});
