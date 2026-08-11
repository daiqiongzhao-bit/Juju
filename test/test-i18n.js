// Locale-Guard für die App-Locales (public/locales/).
//
// Die Gegenstücke existierten längst für den Installer (test-installer-i18n.js)
// und für die Pluralregeln (test-i18n-plural.js) - für den eigentlichen
// Schlüsselabgleich der App gab es nur den manuellen i18n-auditor-Agent. Ein
// Agent läuft, wenn jemand daran denkt; ein fehlender Schlüssel fällt sonst
// erst dem Nutzer auf, weil t() den Schlüssel selbst zurückgibt und damit
// „tasks.newTask" auf dem Button steht.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

const LOCALES_DIR = new URL('../public/locales/', import.meta.url);
const I18N_PATH = new URL('../public/i18n.js', import.meta.url);
const REFERENCE = 'de';

/** SUPPORTED_LOCALES aus i18n.js lesen, statt die Liste hier zu doppeln. */
function supportedLocales() {
  const src = readFileSync(I18N_PATH, 'utf8');
  const match = src.match(/const SUPPORTED_LOCALES = \[([^\]]+)\]/);
  assert.ok(match, 'SUPPORTED_LOCALES nicht in public/i18n.js gefunden');
  return match[1].match(/'([a-z-]+)'/g).map(s => s.slice(1, -1));
}

function readLocale(locale) {
  return readFileSync(new URL(`${locale}.json`, LOCALES_DIR), 'utf8');
}

/** Verschachteltes Objekt zu Dot-Notation abflachen - so löst t() auf. */
function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

/** Platzhalternamen einer Übersetzung: t() ersetzt ausschließlich {{name}}. */
function placeholders(value) {
  if (typeof value !== 'string') return new Set();
  return new Set([...value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map(m => m[1]));
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many)$/;

const LOCALES = supportedLocales();
const reference = flatten(JSON.parse(readLocale(REFERENCE)));
const referenceKeys = [...reference.keys()];

test('für jede unterstützte Locale existiert genau eine Locale-Datei', () => {
  const files = readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json')).sort();
  assert.deepEqual(files, [...LOCALES].sort().map(l => `${l}.json`));
});

test('die Referenz-Locale trägt Schlüssel', () => {
  assert.ok(referenceKeys.length > 1000, `de.json hat nur ${referenceKeys.length} Schlüssel`);
});

// Jede Locale trägt denselben Schlüsselsatz wie de.json - auch Pluralvarianten
// für CLDR-Kategorien, die die Sprache gar nicht kennt (`_few` im Englischen,
// `_one` im Japanischen). Das ist Absicht und kein toter Ballast, den man
// aufräumen sollte: t() wählt die Kategorie über Intl.PluralRules und fällt
// sonst auf den Basisschlüssel zurück, sodass eine ungenutzte Variante folgenlos
// ist - während ein Schlüsselsatz, der sich je Sprache unterscheidet, jedes
// Übersetzungs-Diff zur Einzelfallprüfung machen würde.
for (const locale of LOCALES) {
  if (locale === REFERENCE) continue;

  test(`${locale}.json ist schlüsselidentisch zur Referenz ${REFERENCE}.json`, () => {
    const keys = flatten(JSON.parse(readLocale(locale)));
    const missing = referenceKeys.filter(k => !keys.has(k));
    const extra = [...keys.keys()].filter(k => !reference.has(k));
    assert.deepEqual(missing, [], `${locale}.json fehlen Schlüssel: ${missing.slice(0, 20).join(', ')}`);
    assert.deepEqual(extra, [], `${locale}.json hat überzählige Schlüssel: ${extra.slice(0, 20).join(', ')}`);
  });

  // Ein Platzhalter, den t() nicht befüllt, bleibt als rohes „{{color}}" im
  // Text stehen; einer, der fehlt, macht den Satz unvollständig, ohne dass er
  // beschädigt aussieht. Beides fällt beim Übersetzen nicht auf, weil die
  // Zeile für sich gelesen plausibel ist.
  //
  // Pluralvarianten werden gegen den Basisschlüssel geprüft, nicht gegen die
  // gleichnamige Referenzvariante: eine `_one`-Form darf {{count}} weglassen,
  // weil die Eins schon im Wort steckt („Stündlich" statt „Alle 1 Stunden"),
  // und darf ihn ebenso führen. Nur ein Platzhalter, den der Basisschlüssel
  // gar nicht kennt, ist immer ein Tippfehler.
  test(`${locale}.json nutzt dieselben Platzhalter wie die Referenz`, () => {
    const keys = flatten(JSON.parse(readLocale(locale)));
    const mismatches = [];
    for (const [key, refValue] of reference) {
      if (!keys.has(key)) continue;
      const actual = placeholders(keys.get(key));
      const variant = PLURAL_SUFFIX.test(key);
      const allowed = variant
        ? placeholders(reference.get(key.replace(PLURAL_SUFFIX, '')) ?? refValue)
        : placeholders(refValue);
      const missing = variant ? [] : [...allowed].filter(p => !actual.has(p));
      const extra = [...actual].filter(p => !allowed.has(p));
      if (missing.length || extra.length) {
        mismatches.push(`${key}: fehlt {${missing.join(',')}} überzählig {${extra.join(',')}}`);
      }
    }
    assert.deepEqual(mismatches, [], `${locale}.json:\n  ${mismatches.join('\n  ')}`);
  });
}

// Die Dateien werden von Hand und von Skripten gepflegt. JSON.stringify(o, null, 2)
// reserialisiert sie auf 2 Leerzeichen und erzeugt ein Diff über alle 3400 Zeilen,
// in dem die eine echte Änderung nicht mehr zu finden ist.
test('alle Locale-Dateien sind mit 4 Leerzeichen eingerückt', () => {
  const wrong = [];
  for (const locale of LOCALES) {
    const secondLine = readLocale(locale).split('\n')[1] ?? '';
    const indent = (secondLine.match(/^ */) ?? [''])[0].length;
    if (indent !== 4) wrong.push(`${locale}.json (${indent})`);
  }
  assert.deepEqual(wrong, [], `nicht 4-Leerzeichen-eingerückt: ${wrong.join(', ')}`);
});

test('alle Locale-Dateien enden mit einem Zeilenumbruch', () => {
  const wrong = LOCALES.filter(l => !readLocale(l).endsWith('\n'));
  assert.deepEqual(wrong, [], `ohne abschließenden Zeilenumbruch: ${wrong.join(', ')}`);
});
