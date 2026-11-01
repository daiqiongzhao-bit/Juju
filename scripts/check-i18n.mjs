#!/usr/bin/env node
/**
 * scripts/check-i18n.mjs
 *
 * Prüft die Übersetzungsdateien gegen den tatsächlichen Code-Gebrauch.
 *
 * Warum: `t()` gibt bei einem fehlenden Schlüssel den Schlüssel selbst zurück
 * (public/i18n.js). Ein Tippfehler oder ein vergessener Eintrag landet dann
 * wörtlich als "homeInventory.templatesHeading" in der Oberfläche — genau das
 * ist in 0.0.70 passiert und fiel erst beim Nutzer auf.
 *
 * Geprüft wird:
 *   1. Jeder im Code benutzte Schlüssel muss in en.json existieren  → Fehler
 *   2. Schlüssel in en.json, die im Code nicht (mehr) vorkommen      → Hinweis
 *   3. Fehlende Schlüssel je Sprache gegenüber en.json               → Hinweis
 *
 * Dynamisch zusammengesetzte Schlüssel (`t(`x.${y}`)`) sind statisch nicht
 * auflösbar und werden übersprungen — sie sind in Schritt 1 nicht prüfbar.
 *
 * Aufruf: node scripts/check-i18n.mjs [--strict-locales]
 *   --strict-locales  macht unvollständige Sprachdateien zum Fehler (CI-Opt-in)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'public', 'locales');
const SCAN_DIRS = ['public'];
const BASE_LOCALE = 'en';
const STRICT_LOCALES = process.argv.includes('--strict-locales');

/** Alle .js-Dateien unter den Scan-Verzeichnissen einsammeln. */
async function collectJsFiles(dir, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await collectJsFiles(full, acc);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      acc.push(full);
    }
  }
  return acc;
}

/** Blatt-Schlüssel einer verschachtelten JSON-Struktur als "a.b.c"-Pfade. */
function flatten(obj, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out.set(full, value);
  }
  return out;
}

/**
 * `t('some.key')` im Quelltext finden. Absichtlich konservativ:
 *  - nur String-Literale in einfachen oder doppelten Anführungszeichen
 *  - Template-Literale mit ${…} werden übersprungen (nicht statisch prüfbar)
 */
const T_CALL_RE = /\bt\(\s*(['"])((?:(?!\1)[^\\\n]|\\.)+)\1/g;

/** Zeilennummer eines Zeichens (1-basiert) — für die Fundstelle im Report. */
function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

async function main() {
  const files = (await Promise.all(SCAN_DIRS.map((d) => collectJsFiles(path.join(ROOT, d))))).flat();

  // 1) Schlüssel aus dem Code
  const usedInCode = new Map(); // key -> [datei:zeile, …]
  for (const file of files) {
    // Über die ganze Datei matchen, nicht zeilenweise: mehrzeilige Aufrufe
    // (t(\n  'key',\n  {…})) sind im Code üblich und gingen sonst verloren.
    const src = await fs.readFile(file, 'utf8');
    T_CALL_RE.lastIndex = 0;
    let match;
    while ((match = T_CALL_RE.exec(src)) !== null) {
      const key = match[2];
      // Kein Punkt im Schlüssel → eher ein DOM-Helfer als i18n.
      if (!key.includes('.')) continue;
      // Endet auf "." → statischer Prefix eines Template-Literals
      // (t(`relationships.type.${x}`)), kein echter Schlüssel.
      if (key.endsWith('.')) continue;
      const where = `${path.relative(ROOT, file)}:${lineAt(src, match.index)}`;
      if (!usedInCode.has(key)) usedInCode.set(key, []);
      usedInCode.get(key).push(where);
    }
  }

  // 2) Sprachdateien laden
  const localeFiles = (await fs.readdir(LOCALES_DIR)).filter((f) => f.endsWith('.json'));
  const locales = new Map();
  for (const file of localeFiles) {
    const code = path.basename(file, '.json');
    locales.set(code, flatten(JSON.parse(await fs.readFile(path.join(LOCALES_DIR, file), 'utf8'))));
  }

  const base = locales.get(BASE_LOCALE);
  if (!base) {
    console.error(`✗ Basis-Locale ${BASE_LOCALE}.json nicht gefunden.`);
    process.exit(1);
  }

  let failed = false;

  // 3) Code-Schlüssel, die in en.json fehlen → Fehler
  const missingInBase = [...usedInCode.keys()].filter((k) => !base.has(k)).sort();
  if (missingInBase.length) {
    failed = true;
    console.error(`\n✗ ${missingInBase.length} Schlüssel werden im Code benutzt, fehlen in ${BASE_LOCALE}.json:`);
    for (const key of missingInBase.slice(0, 40)) {
      console.error(`   ${key}   (${usedInCode.get(key)[0]})`);
    }
    if (missingInBase.length > 40) console.error(`   … und ${missingInBase.length - 40} weitere`);
  }

  // 4) Ungenutzte Schlüssel → Hinweis
  const unused = [...base.keys()].filter((k) => !usedInCode.has(k)).sort();

  // 5) Vollständigkeit je Sprache → Hinweis (oder Fehler mit --strict-locales)
  const incomplete = [];
  for (const [code, keys] of locales) {
    if (code === BASE_LOCALE) continue;
    const missing = [...base.keys()].filter((k) => !keys.has(k));
    const extra = [...keys.keys()].filter((k) => !base.has(k));
    if (missing.length || extra.length) incomplete.push({ code, missing, extra });
  }

  console.log(`\nStatistik`);
  console.log(`  Quelldateien:            ${files.length}`);
  console.log(`  Schlüssel im Code:       ${usedInCode.size}`);
  console.log(`  Schlüssel in ${BASE_LOCALE}.json:    ${base.size}`);
  console.log(`  Sprachdateien:           ${locales.size}`);

  if (unused.length) {
    console.log(`\nHinweis: ${unused.length} Schlüssel in ${BASE_LOCALE}.json werden nirgends benutzt`);
    console.log(`  (kann Absicht sein — Modul noch nicht verdrahtet, oder toter Eintrag)`);
    for (const key of unused.slice(0, 10)) console.log(`   ${key}`);
    if (unused.length > 10) console.log(`   … und ${unused.length - 10} weitere`);
  }

  if (incomplete.length) {
    console.log(`\n${STRICT_LOCALES ? '✗' : 'Hinweis'}: unvollständige Sprachdateien`);
    for (const { code, missing, extra } of incomplete.sort((a, b) => b.missing.length - a.missing.length)) {
      const parts = [];
      if (missing.length) parts.push(`${missing.length} fehlen`);
      if (extra.length) parts.push(`${extra.length} überzählig`);
      console.log(`   ${code.padEnd(6)} ${parts.join(', ')}`);
    }
    if (STRICT_LOCALES) failed = true;
  }

  if (!failed) console.log(`\n✓ i18n-Prüfung bestanden`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
