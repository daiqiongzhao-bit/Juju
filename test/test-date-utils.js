/**
 * Tests: Local-date helpers (public/utils/date.js)
 * Fokus: shiftEndDateKey (Enddatum folgt dem Start, Dauer erhalten) und
 *        isEndBeforeStart (Ende-vor-Start-Guard).
 * Läuft rein im Node-Kontext — date.js hat keine DOM-/i18n-Abhängigkeiten.
 * Ausführen: node test/test-date-utils.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { shiftEndDateKey, isEndBeforeStart, weekStartIndex, weekdayOrder } = await import('../public/utils/date.js');

// --- weekStartIndex: Präferenz → getDay()-Index ---

test('weekStartIndex: monday/sunday/saturday → 1/0/6', () => {
  assert.equal(weekStartIndex('monday'), 1);
  assert.equal(weekStartIndex('sunday'), 0);
  assert.equal(weekStartIndex('saturday'), 6);
});

test('weekStartIndex: unbekannter/leerer Wert fällt auf Montag (1) zurück', () => {
  assert.equal(weekStartIndex('friday'), 1);
  assert.equal(weekStartIndex(undefined), 1);
  assert.equal(weekStartIndex(null), 1);
});

// --- weekdayOrder: 7 Indizes in Anzeigereihenfolge ---

test('weekdayOrder: Montag-Start → [1,2,3,4,5,6,0]', () => {
  assert.deepEqual(weekdayOrder('monday'), [1, 2, 3, 4, 5, 6, 0]);
});

test('weekdayOrder: Sonntag-Start → [0,1,2,3,4,5,6]', () => {
  assert.deepEqual(weekdayOrder('sunday'), [0, 1, 2, 3, 4, 5, 6]);
});

test('weekdayOrder: Samstag-Start → [6,0,1,2,3,4,5]', () => {
  assert.deepEqual(weekdayOrder('saturday'), [6, 0, 1, 2, 3, 4, 5]);
});

test('weekdayOrder: akzeptiert auch einen Index und ist immer eine Permutation von 0–6', () => {
  assert.deepEqual(weekdayOrder(6), [6, 0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...weekdayOrder('monday')].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
});

test('weekdayOrder: Default (kein Argument) ist Montag', () => {
  assert.deepEqual(weekdayOrder(), [1, 2, 3, 4, 5, 6, 0]);
});

// --- shiftEndDateKey: Enddatum zieht um dieselbe Tagesdifferenz mit ---

test('shiftEndDateKey: Start +1 Tag → Ende +1 Tag (eintägig bleibt eintägig)', () => {
  assert.equal(shiftEndDateKey('2026-06-05', '2026-06-06', '2026-06-05'), '2026-06-06');
});

test('shiftEndDateKey: erhält eine mehrtägige Dauer beim Vorwärtsschieben', () => {
  // Start 05→10 (+5 Tage), Ende 07 muss auf 12 (+5 Tage) wandern
  assert.equal(shiftEndDateKey('2026-06-05', '2026-06-10', '2026-06-07'), '2026-06-12');
});

test('shiftEndDateKey: schiebt das Ende beim Zurückdatieren mit', () => {
  assert.equal(shiftEndDateKey('2026-06-10', '2026-06-08', '2026-06-12'), '2026-06-10');
});

test('shiftEndDateKey: kein Versatz, wenn der Start gleich bleibt', () => {
  assert.equal(shiftEndDateKey('2026-06-06', '2026-06-06', '2026-06-08'), '2026-06-08');
});

test('shiftEndDateKey: funktioniert über einen Monatswechsel', () => {
  // Start 30.06→01.07 (+1), Ende 30.06 → 01.07
  assert.equal(shiftEndDateKey('2026-06-30', '2026-07-01', '2026-06-30'), '2026-07-01');
});

// --- isEndBeforeStart: Guard ---

test('isEndBeforeStart: getimtes Ende vor Start → true', () => {
  assert.equal(isEndBeforeStart('2026-06-06T09:00', '2026-06-05T10:00'), true);
});

test('isEndBeforeStart: gültiger Bereich → false', () => {
  assert.equal(isEndBeforeStart('2026-06-06T09:00', '2026-06-06T10:00'), false);
});

test('isEndBeforeStart: gleicher Zeitpunkt → false', () => {
  assert.equal(isEndBeforeStart('2026-06-06T09:00', '2026-06-06T09:00'), false);
});

test('isEndBeforeStart: fehlendes Ende (null) → false', () => {
  assert.equal(isEndBeforeStart('2026-06-06T09:00', null), false);
});

test('isEndBeforeStart: ganztägig, gleicher Tag → false', () => {
  assert.equal(isEndBeforeStart('2026-06-06', '2026-06-06'), false);
});

test('isEndBeforeStart: ganztägig, Ende vor Start → true', () => {
  assert.equal(isEndBeforeStart('2026-06-06', '2026-06-05'), true);
});

test('isEndBeforeStart: gleicher Tag, getimter Start + datumsreines Ende → false', () => {
  // Endzeit leer gelassen: nicht als "Ende vor Start" werten (kein False Positive)
  assert.equal(isEndBeforeStart('2026-06-06T09:00', '2026-06-06'), false);
});

test('isEndBeforeStart: späterer Tag mit früherer Uhrzeit → false', () => {
  // Ende am nächsten Tag, aber früherer Uhrzeit – Datum zählt zuerst
  assert.equal(isEndBeforeStart('2026-06-06T22:00', '2026-06-07T08:00'), false);
});
