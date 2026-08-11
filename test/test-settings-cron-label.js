/**
 * Tests: Cron-Ausdruck als Klartext (Settings-Audit 2026-07-27)
 * Zweck: Die Administrationsseite zeigte den rohen `BACKUP_SCHEDULE`
 *        ("Zeitplan 0 2 * * *"). formatCronSchedule() übersetzt die geläufigen
 *        Rhythmen und liefert für alles Übrige null, damit der Ausdruck selbst
 *        stehen bleibt statt falsch zusammengefasst zu werden.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-settings-cron-label.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// Der Loader stubbt /i18n.js mit `t(key, params) => key + JSON.stringify(params)`.
// Geprüft wird damit die Musterzuordnung und die Parameterbelegung; die Texte
// selbst deckt die Locale-Vollständigkeit weiter unten ab.
const { formatCronSchedule } = await import('../public/settings/cron-label.js');

const parse = (expr) => {
  const out = formatCronSchedule(expr);
  if (out == null) return null;
  const at = out.indexOf('{');
  return { key: out.slice(0, at), params: JSON.parse(out.slice(at)) };
};

test('täglich: Standardplan 0 2 * * *', () => {
  const result = parse('0 2 * * *');
  assert.equal(result.key, 'settings.backupSchedulerCronDaily');
  assert.match(result.params.time, /02:00/);
});

test('wöchentlich: Wochentag als Name, nicht als Zahl', () => {
  const monday = parse('30 3 * * 1');
  assert.equal(monday.key, 'settings.backupSchedulerCronWeekly');
  assert.equal(monday.params.weekday, 'Montag');

  // Cron kennt Sonntag als 0 und als 7 - beide müssen denselben Tag nennen.
  assert.equal(parse('0 4 * * 0').params.weekday, 'Sonntag');
  assert.equal(parse('0 4 * * 7').params.weekday, 'Sonntag');
  assert.equal(parse('0 4 * * SUN').params.weekday, 'Sonntag');
});

test('monatlich: Tag im Monat', () => {
  const result = parse('15 1 15 * *');
  assert.equal(result.key, 'settings.backupSchedulerCronMonthly');
  assert.equal(result.params.day, 15);
});

test('Stundenintervall: count trägt die Pluralwahl, minute bleibt zweistellig', () => {
  const every6 = parse('0 */6 * * *');
  assert.equal(every6.key, 'settings.backupSchedulerCronHourly');
  assert.equal(every6.params.count, 6);
  assert.equal(every6.params.minute, '00');
  assert.equal(parse('5 */1 * * *').params.count, 1);
});

test('unbekannte Muster liefern null, damit der Ausdruck selbst stehen bleibt', () => {
  for (const expr of [
    '0 2 * 3 *', // Monatsfeld eingeschränkt
    '0 2,14 * * *', // Liste
    '0 8-17 * * *', // Bereich
    '*/15 * * * *', // Minutenintervall
    '0 2 1 * 1', // Tag im Monat UND Wochentag
    '0 2 * *', // zu wenige Felder
    '0 2 * * * *', // zu viele Felder
    '0 2 32 * *', // ungültiger Tag
    '0 2 * * 9', // ungültiger Wochentag
    '0 */0 * * *', // ungültiger Schritt
    '', null, undefined,
  ]) {
    assert.equal(formatCronSchedule(expr), null, `${JSON.stringify(expr)} sollte null liefern`);
  }
});

test('alle Locales kennen die vier Zeitplan-Muster', () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const required = [
    'backupSchedulerCronDaily',
    'backupSchedulerCronWeekly',
    'backupSchedulerCronMonthly',
    'backupSchedulerCronHourly',
    'backupSchedulerCronHourly_one',
  ];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const settings = JSON.parse(readFileSync(new URL(file, dir), 'utf8')).settings;
    for (const key of required) {
      assert.ok(typeof settings[key] === 'string' && settings[key], `${file}: ${key} fehlt`);
    }
    assert.match(settings.backupSchedulerCronDaily, /\{\{time\}\}/, `${file}: Daily ohne {{time}}`);
    assert.match(settings.backupSchedulerCronWeekly, /\{\{weekday\}\}/, `${file}: Weekly ohne {{weekday}}`);
    assert.match(settings.backupSchedulerCronMonthly, /\{\{day\}\}/, `${file}: Monthly ohne {{day}}`);
    assert.match(settings.backupSchedulerCronHourly, /\{\{count\}\}/, `${file}: Hourly ohne {{count}}`);
  }
});
