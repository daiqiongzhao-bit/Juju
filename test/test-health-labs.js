/**
 * Modul: Laborwerte-Logik-Test
 * Zweck: Reine Funktionen deriveFlag() (Referenz-Flag-Ableitung, spiegelt den
 *        Server), summarizeReport() (Analyten-Anzahl + Auffälligkeiten),
 *        analyteNames() (distinkte Analyt-Namen) und analyteTrend()
 *        (chronologischer Werteverlauf fürs Chart). DOM-frei.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-health-labs.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  deriveFlag,
  summarizeReport,
  analyteNames,
  analyteTrend,
  LAB_FLAGS,
} = await import('../public/utils/health-labs.js');

// --------------------------------------------------------
// deriveFlag — spiegelt die Server-Ableitung
// --------------------------------------------------------

test('LAB_FLAGS listet low/normal/high', () => {
  assert.deepEqual(LAB_FLAGS, ['low', 'normal', 'high']);
});

test('deriveFlag: Wert unter ref_low → low', () => {
  assert.equal(deriveFlag(3, 3.5, 5.5), 'low');
});

test('deriveFlag: Wert über ref_high → high', () => {
  assert.equal(deriveFlag(6, 3.5, 5.5), 'high');
});

test('deriveFlag: Wert innerhalb der Grenzen → normal', () => {
  assert.equal(deriveFlag(4.5, 3.5, 5.5), 'normal');
});

test('deriveFlag: Grenzwerte selbst gelten als normal (inklusive Grenzen)', () => {
  assert.equal(deriveFlag(3.5, 3.5, 5.5), 'normal');
  assert.equal(deriveFlag(5.5, 3.5, 5.5), 'normal');
});

test('deriveFlag: nur eine Grenze gesetzt', () => {
  assert.equal(deriveFlag(10, 5, null), 'normal'); // über Untergrenze, keine Obergrenze
  assert.equal(deriveFlag(2, 5, null), 'low');
  assert.equal(deriveFlag(10, null, 8), 'high');
  assert.equal(deriveFlag(6, null, 8), 'normal');
});

test('deriveFlag: keine Grenze gesetzt → null (kein Flag)', () => {
  assert.equal(deriveFlag(42, null, null), null);
  assert.equal(deriveFlag(42, undefined, undefined), null);
  assert.equal(deriveFlag(42, '', ''), null);
});

test('deriveFlag: fehlender/ungültiger Wert → null', () => {
  assert.equal(deriveFlag(null, 1, 5), null);
  assert.equal(deriveFlag(undefined, 1, 5), null);
  assert.equal(deriveFlag('', 1, 5), null);
  assert.equal(deriveFlag('abc', 1, 5), null);
});

test('deriveFlag: String-Zahlen aus Formularfeldern werden geparst', () => {
  assert.equal(deriveFlag('2', '3.5', '5.5'), 'low');
  assert.equal(deriveFlag('4.5', '3.5', '5.5'), 'normal');
  assert.equal(deriveFlag('9', '3.5', '5.5'), 'high');
});

// --------------------------------------------------------
// summarizeReport
// --------------------------------------------------------

test('summarizeReport: zählt Analyten und Auffälligkeiten', () => {
  const report = {
    results: [
      { analyte: 'Hb', flag: 'normal' },
      { analyte: 'Ferritin', flag: 'low' },
      { analyte: 'CRP', flag: 'high' },
    ],
  };
  const s = summarizeReport(report);
  assert.equal(s.total, 3);
  assert.equal(s.abnormal, 2);
  assert.equal(s.hasAbnormal, true);
});

test('summarizeReport: nur normale Werte → keine Auffälligkeit', () => {
  const s = summarizeReport({ results: [{ flag: 'normal' }, { flag: 'normal' }] });
  assert.equal(s.total, 2);
  assert.equal(s.abnormal, 0);
  assert.equal(s.hasAbnormal, false);
});

test('summarizeReport: null-Flag (kein Referenzbereich) gilt nicht als auffällig', () => {
  const s = summarizeReport({ results: [{ flag: null }, { flag: 'high' }] });
  assert.equal(s.total, 2);
  assert.equal(s.abnormal, 1);
});

test('summarizeReport: fehlende/leere results → 0/0', () => {
  assert.deepEqual(summarizeReport({}), { total: 0, abnormal: 0, hasAbnormal: false });
  assert.deepEqual(summarizeReport(null), { total: 0, abnormal: 0, hasAbnormal: false });
  assert.deepEqual(summarizeReport({ results: [] }), { total: 0, abnormal: 0, hasAbnormal: false });
});

// --------------------------------------------------------
// analyteNames
// --------------------------------------------------------

test('analyteNames: distinkte Namen in Erst-Auftreten-Reihenfolge', () => {
  const reports = [
    { results: [{ analyte: 'Hb' }, { analyte: 'Ferritin' }] },
    { results: [{ analyte: 'Ferritin' }, { analyte: 'CRP' }] },
  ];
  assert.deepEqual(analyteNames(reports), ['Hb', 'Ferritin', 'CRP']);
});

test('analyteNames: case-insensitiv dedupliziert, erste Schreibweise gewinnt', () => {
  const reports = [
    { results: [{ analyte: 'Ferritin' }] },
    { results: [{ analyte: 'ferritin' }, { analyte: '  FERRITIN  ' }] },
  ];
  assert.deepEqual(analyteNames(reports), ['Ferritin']);
});

test('analyteNames: leere Namen und fehlende results werden ignoriert', () => {
  const reports = [
    { results: [{ analyte: '' }, { analyte: '  ' }, { analyte: 'Hb' }] },
    { },
    null,
  ];
  assert.deepEqual(analyteNames(reports), ['Hb']);
});

// --------------------------------------------------------
// analyteTrend
// --------------------------------------------------------

test('analyteTrend: chronologisch aufsteigend nach report_date', () => {
  const reports = [
    { id: 2, report_date: '2026-05-01', results: [{ analyte: 'Hb', value_num: 14, unit: 'g/dL', flag: 'normal', ref_low: 13, ref_high: 17 }] },
    { id: 1, report_date: '2026-03-01', results: [{ analyte: 'Hb', value_num: 12, unit: 'g/dL', flag: 'low', ref_low: 13, ref_high: 17 }] },
    { id: 3, report_date: '2026-07-01', results: [{ analyte: 'Hb', value_num: 15, unit: 'g/dL', flag: 'normal', ref_low: 13, ref_high: 17 }] },
  ];
  const trend = analyteTrend(reports, 'Hb');
  assert.deepEqual(trend.map((p) => p.value), [12, 14, 15]);
  assert.deepEqual(trend.map((p) => p.date), ['2026-03-01', '2026-05-01', '2026-07-01']);
  assert.equal(trend[0].flag, 'low');
  assert.equal(trend[0].unit, 'g/dL');
  assert.equal(trend[0].refLow, 13);
  assert.equal(trend[0].refHigh, 17);
});

test('analyteTrend: case-insensitiver Namensvergleich', () => {
  const reports = [
    { id: 1, report_date: '2026-01-01', results: [{ analyte: 'Glukose', value_num: 90 }] },
    { id: 2, report_date: '2026-02-01', results: [{ analyte: 'glukose', value_num: 95 }] },
  ];
  assert.deepEqual(analyteTrend(reports, 'GLUKOSE').map((p) => p.value), [90, 95]);
});

test('analyteTrend: Befunde ohne den Analyten oder ohne Wert entfallen', () => {
  const reports = [
    { id: 1, report_date: '2026-01-01', results: [{ analyte: 'Hb', value_num: 14 }] },
    { id: 2, report_date: '2026-02-01', results: [{ analyte: 'CRP', value_num: 3 }] }, // anderer Analyt
    { id: 3, report_date: '2026-03-01', results: [{ analyte: 'Hb', value_num: null }] }, // kein Wert
    { id: 4, report_date: '2026-04-01', results: [{ analyte: 'Hb', value_num: 'x' }] }, // ungültig
  ];
  const trend = analyteTrend(reports, 'Hb');
  assert.equal(trend.length, 1);
  assert.equal(trend[0].value, 14);
});

test('analyteTrend: Gleichstand beim Datum → Sortierung nach id', () => {
  const reports = [
    { id: 5, report_date: '2026-01-01', results: [{ analyte: 'Hb', value_num: 15 }] },
    { id: 2, report_date: '2026-01-01', results: [{ analyte: 'Hb', value_num: 13 }] },
  ];
  assert.deepEqual(analyteTrend(reports, 'Hb').map((p) => p.value), [13, 15]);
});

test('analyteTrend: leerer Name oder leere Eingabe → []', () => {
  assert.deepEqual(analyteTrend([{ id: 1, report_date: '2026-01-01', results: [{ analyte: 'Hb', value_num: 14 }] }], ''), []);
  assert.deepEqual(analyteTrend(null, 'Hb'), []);
  assert.deepEqual(analyteTrend(undefined, 'Hb'), []);
});
