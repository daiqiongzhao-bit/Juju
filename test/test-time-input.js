/**
 * Modul: Time-Input-Parsing-Test (Discussion #442)
 * Zweck: Flexible Zeiteingabe — kompakte (0930) und getrennte (09.30 / 9h30)
 *        Schreibweisen werden zu HH:MM normalisiert; bestehende Formate bleiben
 *        gültig; ungültige Werte werden abgelehnt.
 * Ausführen: node --test test/test-time-input.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// getTimeFormatPreference()/formatTimeInput() lesen localStorage — für die reine
// Parsing-Prüfung genügt ein Stub, der auf den 24h-Default zurückfällt.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { parseTimeInput, isTimeInputValid, formatTimeInput } = await import('../public/i18n.js');

test('kompakte Schreibweise HHMM/HMM → HH:MM (#442)', () => {
  assert.equal(parseTimeInput('0930'), '09:30');
  assert.equal(parseTimeInput('930'), '09:30');
  assert.equal(parseTimeInput('1345'), '13:45');
  assert.equal(parseTimeInput('0000'), '00:00');
  assert.equal(parseTimeInput('2359'), '23:59');
});

test('Trennzeichen . , h → HH:MM (#442)', () => {
  assert.equal(parseTimeInput('09.30'), '09:30');
  assert.equal(parseTimeInput('9,30'), '09:30');
  assert.equal(parseTimeInput('9h30'), '09:30');
  assert.equal(parseTimeInput('9H30'), '09:30');
});

test('bestehende Formate bleiben gültig', () => {
  assert.equal(parseTimeInput('9'), '09:00');
  assert.equal(parseTimeInput('09'), '09:00');
  assert.equal(parseTimeInput('9:30'), '09:30');
  assert.equal(parseTimeInput('09:30'), '09:30');
  assert.equal(parseTimeInput('9:30 pm'), '21:30');
});

test('ungültige kompakte/getrennte Werte werden abgelehnt', () => {
  assert.equal(parseTimeInput('2400'), '');   // Stunde 24 unzulässig
  assert.equal(parseTimeInput('1360'), '');   // Minute 60 unzulässig
  assert.equal(parseTimeInput('9.60'), '');   // Minute 60 unzulässig
  assert.equal(parseTimeInput('99999'), '');  // 5 Ziffern kein gültiges Format
  assert.equal(parseTimeInput('25'), '');     // 25 als Stunde unzulässig
});

test('isTimeInputValid akzeptiert neue Formate und leere Eingabe', () => {
  assert.equal(isTimeInputValid('0930'), true);
  assert.equal(isTimeInputValid('09.30'), true);
  assert.equal(isTimeInputValid(''), true);
  assert.equal(isTimeInputValid('2400'), false);
});

test('formatTimeInput normalisiert kompakte Eingabe (24h-Default)', () => {
  assert.equal(formatTimeInput('0930'), '09:30');
  assert.equal(formatTimeInput('9h30'), '09:30');
});
