/**
 * Modul: Vitalwerte-Aggregation-Test
 * Zweck: Reine Funktion computeVitalSeries() + buildVitalBuckets() —
 *        Zeitraum-Bucketing (week/month/year), Aggregation (Mittelwert je
 *        Bucket), Kennzahlen (letzter Wert + Delta zum Vorwert) und
 *        Typ-/Zeitraum-Filter. DOM-frei.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-health-vitals.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  computeVitalSeries,
  buildVitalBuckets,
  vitalMetric,
  VITAL_TYPES,
  VITAL_METRICS,
  MOOD_SCALE,
  MOOD_MIN,
  MOOD_MAX,
  moodStep,
  splitDuration,
  durationToHours,
} = await import('../public/utils/health-vitals.js');

// --------------------------------------------------------
// Metrik-Definitionen
// --------------------------------------------------------

test('VITAL_TYPES enthält alle neun Metriken', () => {
  assert.deepEqual(VITAL_TYPES, [
    'bp', 'glucose', 'weight', 'height', 'head_circumference', 'spo2', 'temp', 'sleep', 'mood',
  ]);
  assert.equal(VITAL_METRICS.length, 9);
});

// #683: Körpermaße für Säuglinge. Rohe Messwerte ohne Bewertung - hier steht,
// was das heißt, damit eine spätere Perzentil-Idee als bewusste Erweiterung
// erkennbar ist und nicht als vergessenes Detail.
test('Körpermaße sind schlichte Längen in derselben Einheitenwahl', () => {
  for (const type of ['height', 'head_circumference']) {
    const m = vitalMetric(type);
    assert.ok(m, `${type} fehlt`);
    assert.deepEqual(m.channels, ['value_num'], `${type}: ein Kanal`);
    assert.deepEqual(m.units, ['cm', 'in'], `${type}: metrisch und imperial`);
    assert.equal(m.format, undefined, `${type}: kein Sonderformat`);
    assert.equal(m.domain, undefined, `${type}: keine geklemmte Achse - ein Kind waechst aus jeder`);
  }
});

test('Blutdruck belegt drei Kanäle, übrige Metriken einen', () => {
  assert.deepEqual(vitalMetric('bp').channels, ['value_num', 'value_num2', 'value_num3']);
  assert.deepEqual(vitalMetric('weight').channels, ['value_num']);
  assert.equal(vitalMetric('unknown'), null);
});

// Die Darstellung (Paar, Dauer, Skala) hängt an `format`, nicht am Typ-Namen:
// Karte, Verlaufsliste, Chart und Übersicht fragen ausschließlich dieses Feld
// ab. Ein Tippfehler hier bliebe sonst bis in die Oberfläche unbemerkt.
test('jede Metrik trägt genau ein bekanntes Anzeigeformat', () => {
  const KNOWN = ['pair', 'duration', 'scale'];
  const byType = Object.fromEntries(VITAL_METRICS.map((m) => [m.type, m.format]));
  assert.equal(byType.bp, 'pair');
  assert.equal(byType.sleep, 'duration');
  assert.equal(byType.mood, 'scale');
  for (const m of VITAL_METRICS) {
    if (m.format !== undefined) assert.ok(KNOWN.includes(m.format), `${m.type}: ${m.format}`);
  }
  // Schlichte Zahlenwerte tragen bewusst kein Format.
  assert.equal(byType.weight, undefined);
});

test('Stimmung trägt keine Einheit, Schlaf rechnet in Stunden', () => {
  assert.deepEqual(vitalMetric('mood').units, []);
  assert.deepEqual(vitalMetric('sleep').units, ['h']);
});

// --------------------------------------------------------
// Stimmungs-Skala (#609)
// --------------------------------------------------------

test('MOOD_SCALE ist eine lückenlose 1-5-Skala', () => {
  assert.deepEqual(MOOD_SCALE.map((s) => s.value), [1, 2, 3, 4, 5]);
  assert.equal(MOOD_MIN, 1);
  assert.equal(MOOD_MAX, 5);
  for (const step of MOOD_SCALE) {
    assert.ok(step.labelKey.startsWith('health.vitals.mood.'));
    assert.ok(step.icon);
  }
});

test('moodStep rundet den Tagesmittelwert auf eine Stufe', () => {
  assert.equal(moodStep(4).value, 4);
  assert.equal(moodStep(3.5).value, 4);
  assert.equal(moodStep(3.4).value, 3);
  assert.equal(moodStep('2').value, 2);
});

test('moodStep klemmt außerhalb der Skala statt undefined zu liefern', () => {
  assert.equal(moodStep(0).value, 1);
  assert.equal(moodStep(9).value, 5);
  assert.equal(moodStep(null), null);
  assert.equal(moodStep('keine Zahl'), null);
});

// --------------------------------------------------------
// Schlafdauer (#609)
// --------------------------------------------------------

test('splitDuration zerlegt Dezimalstunden in Stunden und Minuten', () => {
  assert.deepEqual(splitDuration(7.5), { hours: 7, minutes: 30 });
  assert.deepEqual(splitDuration(8), { hours: 8, minutes: 0 });
  assert.deepEqual(splitDuration(0.25), { hours: 0, minutes: 15 });
});

// Rundungsfehler dürfen nicht als "7 h 60 min" herauskommen - die Minute wird
// vor dem Zerlegen gerundet, nicht danach.
test('splitDuration rundet auf die Minute, ohne 60 Minuten zu erzeugen', () => {
  assert.deepEqual(splitDuration(7.999), { hours: 8, minutes: 0 });
  assert.deepEqual(splitDuration(1 / 3), { hours: 0, minutes: 20 });
  assert.equal(splitDuration(-1), null);
  assert.equal(splitDuration('viel'), null);
});

test('durationToHours ist die Umkehrung von splitDuration', () => {
  assert.equal(durationToHours(7, 30), 7.5);
  assert.equal(durationToHours(0, 45), 0.75);
  assert.equal(durationToHours(8, 0), 8);
  for (const value of [6.25, 7.5, 8.75, 0.5]) {
    const { hours, minutes } = splitDuration(value);
    assert.equal(durationToHours(hours, minutes), value);
  }
});

test('durationToHours behandelt leere Felder als null Minuten', () => {
  assert.equal(durationToHours(7, ''), 7);
  assert.equal(durationToHours('', ''), 0);
  assert.equal(durationToHours(-1, 0), null);
});

// Schlaf und Stimmung müssen dieselbe Aggregation wie jede andere Metrik
// durchlaufen - sie sind Kanal-1-Metriken, kein Sonderweg.
test('Schlaf und Stimmung aggregieren wie jede andere Einkanal-Metrik', () => {
  const rows = [
    { id: 1, type: 'sleep', value_num: 7.5, measured_at: '2026-06-15T07:00:00' },
    { id: 2, type: 'sleep', value_num: 6.5, measured_at: '2026-06-16T07:00:00' },
    { id: 3, type: 'mood', value_num: 4, measured_at: '2026-06-15T20:00:00' },
    { id: 4, type: 'mood', value_num: 2, measured_at: '2026-06-15T22:00:00' },
  ];
  const sleep = computeVitalSeries(rows, { type: 'sleep', range: 'month', anchor: '2026-06-15' });
  assert.equal(sleep.latest.id, 2);
  assert.equal(sleep.deltas.value_num, -1);

  const mood = computeVitalSeries(rows, { type: 'mood', range: 'month', anchor: '2026-06-15' });
  // Zwei Einträge am selben Tag mitteln sich zu 3 - moodStep() rundet das zurück
  // auf eine Stufe der Skala.
  const day = mood.points.find((p) => p.date === '2026-06-15');
  assert.equal(day.value_num, 3);
  assert.equal(moodStep(day.value_num).value, 3);
});

// --------------------------------------------------------
// buildVitalBuckets
// --------------------------------------------------------

test('week → 7 Tages-Buckets, from ≤ to', () => {
  const { buckets, from, to, gran } = buildVitalBuckets('week', '2026-06-15');
  assert.equal(buckets.length, 7);
  assert.equal(gran, 'day');
  assert.ok(from <= to);
  assert.equal(buckets[0].date, from);
  assert.equal(buckets[6].date, to);
});

test('month → ein Bucket je Kalendertag (Schaltjahr-korrekt)', () => {
  assert.equal(buildVitalBuckets('month', '2026-06-15').buckets.length, 30); // Juni
  assert.equal(buildVitalBuckets('month', '2026-02-10').buckets.length, 28); // Feb 2026
  assert.equal(buildVitalBuckets('month', '2024-02-10').buckets.length, 29); // Feb 2024 (Schaltjahr)
});

test('year → 12 Monats-Buckets', () => {
  const { buckets, from, to, gran } = buildVitalBuckets('year', '2026-06-15');
  assert.equal(buckets.length, 12);
  assert.equal(gran, 'month');
  assert.equal(buckets[0].key, '2026-01');
  assert.equal(buckets[11].key, '2026-12');
  assert.equal(from, '2026-01-01');
  assert.equal(to, '2026-12-31');
});

// --------------------------------------------------------
// computeVitalSeries — leer / Filter
// --------------------------------------------------------

test('leere Rohdaten → keine Serie, keine Kennzahlen', () => {
  const s = computeVitalSeries([], { type: 'weight', range: 'month', anchor: '2026-06-15' });
  assert.equal(s.hasData, false);
  assert.equal(s.latest, null);
  assert.equal(s.previous, null);
  assert.equal(s.deltas.value_num, null);
  assert.equal(s.points.length, 30);
  assert.ok(s.points.every((p) => p.count === 0 && p.value_num === null));
});

test('fremde Typen werden ignoriert', () => {
  const rows = [
    { id: 1, type: 'glucose', value_num: 95, measured_at: '2026-06-10T08:00' },
    { id: 2, type: 'weight', value_num: 70, measured_at: '2026-06-10T08:00' },
  ];
  const s = computeVitalSeries(rows, { type: 'weight', range: 'month', anchor: '2026-06-15' });
  assert.equal(s.hasData, true);
  assert.equal(s.latest.value_num, 70);
});

// --------------------------------------------------------
// Aggregation (Mittelwert je Bucket)
// --------------------------------------------------------

test('Tages-Bucket mittelt mehrere Messungen desselben Tages', () => {
  const rows = [
    { id: 1, type: 'weight', value_num: 70, measured_at: '2026-06-01T08:00' },
    { id: 2, type: 'weight', value_num: 72, measured_at: '2026-06-01T20:00' },
    { id: 3, type: 'weight', value_num: 69, measured_at: '2026-06-10T08:00' },
  ];
  const s = computeVitalSeries(rows, { type: 'weight', range: 'month', anchor: '2026-06-15' });
  const day1 = s.points.find((p) => p.key === '2026-06-01');
  const day10 = s.points.find((p) => p.key === '2026-06-10');
  assert.equal(day1.count, 2);
  assert.equal(day1.value_num, 71); // (70 + 72) / 2
  assert.equal(day10.count, 1);
  assert.equal(day10.value_num, 69);
});

test('year → Monats-Buckets mitteln über den Monat', () => {
  const rows = [
    { id: 1, type: 'weight', value_num: 70, measured_at: '2026-06-01T08:00' },
    { id: 2, type: 'weight', value_num: 72, measured_at: '2026-06-01T20:00' },
    { id: 3, type: 'weight', value_num: 69, measured_at: '2026-06-10T08:00' },
    { id: 4, type: 'weight', value_num: 80, measured_at: '2026-05-20T08:00' },
  ];
  const s = computeVitalSeries(rows, { type: 'weight', range: 'year', anchor: '2026-06-15' });
  const june = s.points.find((p) => p.key === '2026-06');
  const may = s.points.find((p) => p.key === '2026-05');
  assert.equal(june.count, 3);
  assert.ok(Math.abs(june.value_num - (70 + 72 + 69) / 3) < 1e-9);
  assert.equal(may.count, 1);
  assert.equal(may.value_num, 80);
});

// --------------------------------------------------------
// Kennzahlen: letzter Wert + Delta zum Vorwert
// --------------------------------------------------------

test('Delta = jüngste Messung minus Vormessung, je Kanal (Blutdruck)', () => {
  const rows = [
    { id: 1, type: 'bp', value_num: 120, value_num2: 80, value_num3: 60, measured_at: '2026-06-05T08:00' },
    { id: 2, type: 'bp', value_num: 130, value_num2: 85, value_num3: 62, measured_at: '2026-06-06T08:00' },
  ];
  const s = computeVitalSeries(rows, { type: 'bp', range: 'month', anchor: '2026-06-15' });
  assert.equal(s.latest.id, 2);
  assert.equal(s.previous.id, 1);
  assert.equal(s.deltas.value_num, 10);
  assert.equal(s.deltas.value_num2, 5);
  assert.equal(s.deltas.value_num3, 2);
});

test('Delta ist zeitraum-unabhängig — Vorwert außerhalb des Zeitraums zählt', () => {
  const rows = [
    { id: 1, type: 'weight', value_num: 80, measured_at: '2026-05-20T08:00' }, // Mai, außerhalb Juni
    { id: 2, type: 'weight', value_num: 78, measured_at: '2026-06-10T08:00' }, // Juni
  ];
  const s = computeVitalSeries(rows, { type: 'weight', range: 'month', anchor: '2026-06-15' });
  // Serie (Juni) enthält nur die Juni-Messung ...
  assert.equal(s.points.find((p) => p.key === '2026-06-10').value_num, 78);
  assert.ok(s.points.every((p) => p.key === '2026-06-10' || p.count === 0));
  // ... das Delta bezieht dennoch den Mai-Vorwert ein.
  assert.equal(s.latest.value_num, 78);
  assert.equal(s.previous.value_num, 80);
  assert.equal(s.deltas.value_num, -2);
});

test('einzelne Messung → letzter Wert, aber kein Delta', () => {
  const rows = [{ id: 1, type: 'glucose', value_num: 95, measured_at: '2026-06-10T08:00' }];
  const s = computeVitalSeries(rows, { type: 'glucose', range: 'week', anchor: '2026-06-10' });
  assert.equal(s.latest.value_num, 95);
  assert.equal(s.previous, null);
  assert.equal(s.deltas.value_num, null);
});
