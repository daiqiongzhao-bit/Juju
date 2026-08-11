import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createInstallerServer } from '../tools/installer/install-server.js';
import { SUPPORTED_LOCALES } from '../tools/installer/i18n-mini.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOCALES_DIR = new URL('../tools/installer/locales/', import.meta.url);
const HTML_PATH = new URL('../tools/installer/install.html', import.meta.url);
const REFERENCE = 'de';

function loadLocale(locale) {
  return JSON.parse(readFileSync(new URL(`${locale}.json`, LOCALES_DIR), 'utf8'));
}

/** Verschachteltes Objekt zu Dot-Notation-Schlüsselmenge abflachen. */
function flattenKeys(obj, prefix = '', out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenKeys(v, key, out);
    else out.add(key);
  }
  return out;
}

/** Alle in install.html referenzierten i18n-Schlüssel (Attribute, t(), applyRich). */
function referencedKeys() {
  const html = readFileSync(HTML_PATH, 'utf8');
  const attr = [...html.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map(m => m[1]);
  const calls = [...html.matchAll(/\bt\('([^']+)'/g)].map(m => m[1]);
  const rich = [...html.matchAll(/applyRich\([^,]+,\s*'([^']+)'/g)].map(m => m[1]);
  return new Set([...attr, ...calls, ...rich]);
}

const referenceKeys = flattenKeys(loadLocale(REFERENCE));

// ── Locale-Dateien vollständig & schlüsselidentisch ──────────────────────────

test('für jede unterstützte Locale existiert genau eine Locale-Datei', () => {
  const files = readdirSync(new URL(LOCALES_DIR)).filter(f => f.endsWith('.json')).sort();
  assert.deepEqual(files, [...SUPPORTED_LOCALES].sort().map(l => `${l}.json`));
});

for (const locale of SUPPORTED_LOCALES) {
  test(`${locale}.json ist schlüsselidentisch zur Referenz ${REFERENCE}.json`, () => {
    const keys = flattenKeys(loadLocale(locale));
    const missing = [...referenceKeys].filter(k => !keys.has(k));
    const extra = [...keys].filter(k => !referenceKeys.has(k));
    assert.deepEqual(missing, [], `${locale}.json fehlen Schlüssel: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${locale}.json hat überzählige Schlüssel: ${extra.join(', ')}`);
  });
}

// ── install.html ⇄ Locales ───────────────────────────────────────────────────

test('install.html enthält i18n-Schlüssel (data-i18n vorhanden)', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const count = (html.match(/data-i18n/g) || []).length;
  assert.ok(count > 0, 'keine data-i18n-Attribute in install.html gefunden');
});

test('jeder in install.html referenzierte Schlüssel existiert in der Referenz', () => {
  const used = referencedKeys();
  const unknown = [...used].filter(k => !referenceKeys.has(k));
  assert.deepEqual(unknown, [], `Unbekannte Schlüssel in install.html: ${unknown.join(', ')}`);
});

test('jeder in install.html referenzierte Schlüssel existiert in jeder Locale', () => {
  const used = referencedKeys();
  for (const locale of SUPPORTED_LOCALES) {
    const keys = flattenKeys(loadLocale(locale));
    const missing = [...used].filter(k => !keys.has(k));
    assert.deepEqual(missing, [], `${locale}.json fehlen genutzte Schlüssel: ${missing.join(', ')}`);
  }
});

// ── Auslieferung über den Installer-Server ────────────────────────────────────

async function withServer(fn) {
  const prev = process.env.OIKOS_INSTALLER_ROOT;
  process.env.OIKOS_INSTALLER_ROOT = REPO_ROOT;
  const server = createInstallerServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(r => server.close(r));
    if (prev === undefined) delete process.env.OIKOS_INSTALLER_ROOT;
    else process.env.OIKOS_INSTALLER_ROOT = prev;
  }
}

test('GET /i18n-mini.js liefert 200 + JavaScript', async () => {
  await withServer(async base => {
    const r = await fetch(`${base}/i18n-mini.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.match(await r.text(), /export function t\(/);
  });
});

test('GET /locales/<locale>.json liefert 200 + JSON für jede Locale', async () => {
  await withServer(async base => {
    for (const locale of SUPPORTED_LOCALES) {
      const r = await fetch(`${base}/locales/${locale}.json`);
      assert.equal(r.status, 200, `/locales/${locale}.json lieferte ${r.status}`);
      assert.match(r.headers.get('content-type'), /application\/json/);
      const body = await r.json();
      assert.ok(body.title, `${locale}.json hat keinen title-Schlüssel`);
    }
  });
});

test('GET /locales/* lehnt Path-Traversal und Nicht-JSON mit 404 ab', async () => {
  await withServer(async base => {
    for (const path of ['/locales/../install.html', '/locales/nope.json', '/locales/de.txt']) {
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 404, `${path} hätte 404 liefern müssen`);
    }
  });
});

// ── Regel-Guard: kein Locale-Wert besteht nur aus Zeichensetzung ─────────────
//
// `common.generating` stand in allen 23 Sprachen woertlich auf "…". Der
// Generieren-Button setzt diesen Wert als textContent, verlor damit fuer die
// Dauer der Operation seinen zugaenglichen Namen und wurde als
// "Auslassungspunkte, Schaltflaeche, deaktiviert" vorgelesen.
//
// Der Keyset-Guard darueber konnte das nicht sehen: der Schluessel WAR in jeder
// Sprache vorhanden, nur ohne Inhalt. Ein Wert ohne einen einzigen Buchstaben
// oder eine Ziffer ist keine Uebersetzung, sondern ein Platzhalter, der es in
// den Bestand geschafft hat.
test('kein Locale-Wert besteht ausschliesslich aus Zeichensetzung', () => {
  // \p{L} deckt jedes Alphabet ab (kyrillisch, arabisch, CJK), \p{N} Ziffern.
  // Emoji und Haken duerfen begleiten, aber nicht die ganze Aussage tragen.
  const hasContent = (value) => /[\p{L}\p{N}]/u.test(value);
  const offenders = [];

  for (const locale of SUPPORTED_LOCALES) {
    const walk = (obj, prefix = '') => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
        else if (typeof v === 'string' && v.length > 0 && !hasContent(v)) {
          offenders.push(`${locale}: ${key} = ${JSON.stringify(v)}`);
        }
      }
    };
    walk(loadLocale(locale));
  }

  assert.deepEqual(offenders, [],
    'Diese Werte enthalten keinen einzigen Buchstaben und keine Ziffer. Steht so '
    + 'einer auf einem Button, hat das Element keinen Namen mehr:\n' + offenders.join('\n'));
});

test('der Generieren-Button traegt waehrend der Operation einen Namen und haengt nicht', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  // Der Zustand muss angesagt werden, nicht nur bebildert.
  assert.match(html, /btn\.setAttribute\('aria-busy', 'true'\)/,
    'der Generieren-Button meldet seinen Betriebszustand nicht');
  // Ohne finally blieb der Button nach einem Fehlschlag dauerhaft deaktiviert
  // und im Ersatztext stehen: der Schritt war nur per Reload verlassbar.
  assert.match(html, /\} finally \{[\s\S]*?btn\.disabled = false;[\s\S]*?btn\.textContent = t\('common\.generate'\);/,
    'der Generieren-Button wird nicht in jedem Fall zurueckgesetzt');
});

test('Zahlenbereiche in Fehlermeldungen sind mit ASCII-Minus geschrieben', () => {
  // "Ungültiger Breitengrad (–90 bis 90)" nannte in 19 Sprachen einen Wert, den
  // das Feld gar nicht annimmt: <input type="number"> kennt nur ASCII-Minus.
  // Wer die Zahl aus der Meldung kopierte, bekam dieselbe Meldung erneut.
  //
  // Die Regel trifft nur Striche, die unmittelbar an einer Ziffer kleben -
  // Vorzeichen und Bis-Striche. Der Gedankenstrich als Satzzeichen ist davon
  // unberührt: er trägt in ru, uk, fr, ja und zh die Satzstruktur und bleibt.
  const offenders = [];
  for (const locale of SUPPORTED_LOCALES) {
    const walk = (obj, prefix = '') => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
        else if (typeof v === 'string' && /[–—](?=[0-9])/u.test(v)) {
          offenders.push(`${locale}: ${key} = ${JSON.stringify(v)}`);
        }
      }
    };
    walk(loadLocale(locale));
  }
  assert.deepEqual(offenders, [],
    'En-/Em-Dash direkt vor einer Ziffer ist ein Vorzeichen oder Bis-Strich und '
    + 'gehört als ASCII "-" geschrieben:\n' + offenders.join('\n'));
});
