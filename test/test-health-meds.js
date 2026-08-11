/**
 * Modul: Medikamenten-Logik-Test
 * Zweck: Reine Funktionen computeDueDoses (days_mask/Zeitfenster/Zeitraum-Bucketing),
 *        computeAdherence und refillState plus Wochentags-Masken-Helfer. DOM-frei.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-health-meds.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  WEEKDAY_COUNT,
  weekdayIndex,
  daysMaskMatches,
  daysMaskToIndices,
  indicesToDaysMask,
  computeDueDoses,
  computeAdherence,
  refillState,
} = await import('../public/utils/health-meds.js');

// --------------------------------------------------------
// Wochentags-Masken
// --------------------------------------------------------

test('weekdayIndex: Montag = 0 … Sonntag = 6', () => {
  assert.equal(WEEKDAY_COUNT, 7);
  assert.equal(weekdayIndex('2026-06-15'), 0); // Montag
  assert.equal(weekdayIndex('2026-06-20'), 5); // Samstag
  assert.equal(weekdayIndex('2026-06-21'), 6); // Sonntag
});

test('daysMaskMatches: NULL/leer = täglich, sonst Bitmaske', () => {
  assert.equal(daysMaskMatches(null, 0), true);
  assert.equal(daysMaskMatches(undefined, 3), true);
  assert.equal(daysMaskMatches('', 6), true);
  // Nur Montag (Bit 0) + Mittwoch (Bit 2) = 0b0000101 = 5
  assert.equal(daysMaskMatches(5, 0), true);
  assert.equal(daysMaskMatches(5, 1), false);
  assert.equal(daysMaskMatches(5, 2), true);
});

test('daysMaskToIndices / indicesToDaysMask sind konsistent', () => {
  assert.deepEqual(daysMaskToIndices(null), [0, 1, 2, 3, 4, 5, 6]); // täglich
  assert.deepEqual(daysMaskToIndices(5), [0, 2]);
  // Round-Trip einer echten Teilmenge
  assert.equal(indicesToDaysMask([0, 2]), 5);
  // Alle oder keine Tage → null (= täglich)
  assert.equal(indicesToDaysMask([0, 1, 2, 3, 4, 5, 6]), null);
  assert.equal(indicesToDaysMask([]), null);
});

// --------------------------------------------------------
// computeDueDoses
// --------------------------------------------------------

test('computeDueDoses: tägliches Zeitfenster über eine Woche', () => {
  const schedules = [
    { id: 1, medication_id: 10, time_of_day: '08:00', days_mask: null, dose_qty: 1, active: 1 },
  ];
  const doses = computeDueDoses(schedules, { from: '2026-06-15', to: '2026-06-21' });
  assert.equal(doses.length, 7);
  assert.equal(doses[0].scheduledAt, '2026-06-15T08:00');
  assert.equal(doses[0].scheduleId, 1);
  assert.equal(doses[0].medicationId, 10);
  assert.equal(doses[0].dose_qty, 1);
});

test('computeDueDoses: days_mask filtert Wochentage', () => {
  // Nur Mo (0) + Mi (2) = 5
  const schedules = [
    { id: 2, medication_id: 11, time_of_day: '20:00', days_mask: 5, dose_qty: 2, active: 1 },
  ];
  const doses = computeDueDoses(schedules, { from: '2026-06-15', to: '2026-06-21' });
  // Mo 15., Mi 17. → 2 Dosen
  assert.equal(doses.length, 2);
  assert.deepEqual(doses.map((d) => d.date), ['2026-06-15', '2026-06-17']);
});

test('computeDueDoses: mehrere Zeitfenster pro Tag, chronologisch sortiert', () => {
  const schedules = [
    { id: 1, medication_id: 10, time_of_day: '20:00', days_mask: null, dose_qty: 1, active: 1 },
    { id: 2, medication_id: 10, time_of_day: '08:00', days_mask: null, dose_qty: 1, active: 1 },
  ];
  const doses = computeDueDoses(schedules, { from: '2026-06-15', to: '2026-06-15' });
  assert.equal(doses.length, 2);
  assert.equal(doses[0].scheduledAt, '2026-06-15T08:00');
  assert.equal(doses[1].scheduledAt, '2026-06-15T20:00');
});

test('computeDueDoses: inaktive Pläne und Start/End-Grenzen', () => {
  const schedules = [
    { id: 1, medication_id: 10, time_of_day: '08:00', days_mask: null, active: 0 },
    { id: 2, medication_id: 11, time_of_day: '09:00', days_mask: null, active: 1, start_date: '2026-06-18' },
    { id: 3, medication_id: 12, time_of_day: '10:00', days_mask: null, active: 1, end_date: '2026-06-16' },
  ];
  const doses = computeDueDoses(schedules, { from: '2026-06-15', to: '2026-06-19' });
  // Plan 1 inaktiv → nie; Plan 2 ab 18.; Plan 3 bis 16.
  assert.equal(doses.filter((d) => d.scheduleId === 1).length, 0);
  assert.deepEqual(doses.filter((d) => d.scheduleId === 2).map((d) => d.date), ['2026-06-18', '2026-06-19']);
  assert.deepEqual(doses.filter((d) => d.scheduleId === 3).map((d) => d.date), ['2026-06-15', '2026-06-16']);
});

test('computeDueDoses: leerer / ungültiger Zeitraum → []', () => {
  assert.deepEqual(computeDueDoses([], { from: '2026-06-15', to: '2026-06-21' }), []);
  assert.deepEqual(computeDueDoses([{ id: 1, time_of_day: '08:00' }], {}), []);
  assert.deepEqual(computeDueDoses([{ id: 1, time_of_day: '08:00' }], { from: '2026-06-21', to: '2026-06-15' }), []);
});

// --------------------------------------------------------
// computeAdherence
// --------------------------------------------------------

test('computeAdherence: genommen / geplant', () => {
  const logs = [
    { status: 'taken' }, { status: 'taken' }, { status: 'skipped' }, { status: 'pending' },
  ];
  const a = computeAdherence(logs, 5);
  assert.equal(a.taken, 2);
  assert.equal(a.skipped, 1);
  assert.equal(a.pending, 1);
  assert.equal(a.planned, 5);
  assert.equal(a.rate, 2 / 5);
});

test('computeAdherence: ohne planned → Basis aus getroffenen Entscheidungen', () => {
  const logs = [{ status: 'taken' }, { status: 'taken' }, { status: 'skipped' }];
  const a = computeAdherence(logs);
  assert.equal(a.planned, 3); // taken + skipped
  assert.equal(a.rate, 2 / 3);
});

test('computeAdherence: nie über 100 % bei Ad-hoc-Logs', () => {
  const logs = [{ status: 'taken' }, { status: 'taken' }, { status: 'taken' }];
  const a = computeAdherence(logs, 1); // mehr genommen als geplant
  assert.equal(a.rate, 1); // gedeckelt auf 3/3
});

test('computeAdherence: keine Basis → rate null', () => {
  const a = computeAdherence([], 0);
  assert.equal(a.rate, null);
  assert.equal(a.taken, 0);
});

// --------------------------------------------------------
// refillState
// --------------------------------------------------------

test('refillState: kein Bestand erfasst → none', () => {
  const s = refillState({ stock_qty: null, refill_threshold: 5 });
  assert.equal(s.level, 'none');
  assert.equal(s.stock, null);
  assert.equal(s.below, false);
});

test('refillState: leer → out', () => {
  const s = refillState({ stock_qty: 0, refill_threshold: 5 });
  assert.equal(s.level, 'out');
  assert.equal(s.below, true);
});

test('refillState: unter/gleich Schwelle → low', () => {
  assert.equal(refillState({ stock_qty: 5, refill_threshold: 5 }).level, 'low');
  assert.equal(refillState({ stock_qty: 3, refill_threshold: 5 }).level, 'low');
  assert.equal(refillState({ stock_qty: 3, refill_threshold: 5 }).below, true);
});

test('refillState: über Schwelle oder ohne Schwelle → ok', () => {
  assert.equal(refillState({ stock_qty: 10, refill_threshold: 5 }).level, 'ok');
  assert.equal(refillState({ stock_qty: 10, refill_threshold: null }).level, 'ok');
  assert.equal(refillState({ stock_qty: 10, refill_threshold: null }).below, false);
});
