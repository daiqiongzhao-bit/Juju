/**
 * Schicht-Guard (Frontend/Backend-Grenze).
 * Hält die Architektur-Invariante dauerhaft:
 *
 *   - `public/` (Browser-Frontend) importiert NIEMALS aus `server/`.
 *     Frontend-Code läuft im Browser; ein Server-Modul (node:*, better-sqlite3,
 *     Middleware) dort zu importieren bricht zur Laufzeit und vermischt die Schichten.
 *   - `server/` (Node-Backend) importiert aus `public/` NUR bewusst geteilte,
 *     isomorphe Utilities aus der Allowlist unten (reine Funktionen ohne DOM/Node-
 *     Abhängigkeit, die Front- und Backend identisch nutzen sollen).
 *
 * Motivation: Ein AST-Namensauflöser (z. B. graphify) band gleichnamige Funktionen
 * (`num()`, `save()`) über die Schichtgrenze hinweg falsch aneinander. Die Regel
 * „public/ ruft nie server/ direkt auf, außer über geteilte isomorphe Utils" ist der
 * zuverlässige Filter dafür — und zugleich eine echte Architektur-Invariante des
 * Produkts. Dieser Guard erzwingt sie an der Quelle statt am regenerierten Graphen.
 *
 * Eine neue geteilte isomorphe Util wird bewusst durch Aufnahme in SHARED_ISOMORPHIC
 * freigegeben — nicht durch Aufweichen der Regel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const SERVER_DIR = path.join(ROOT, 'server');

/**
 * Allowlist geteilter, isomorpher Module (repo-relativer Pfad), die `server/`
 * aus `public/` importieren darf. Reine Funktionen, front- und backend-identisch.
 */
const SHARED_ISOMORPHIC = new Set([
  'public/utils/recipe-meal-types.js',
  'public/utils/contact-name.js',
  'public/utils/pantry-units.js',
  // #620: Das Format der Sync-Ziel-Kennung. Der Server validiert genau das,
  // was Event-Modal und Einstellungen bauen - zwei Definitionen desselben
  // Formats würden sich unbemerkt auseinanderentwickeln.
  'public/utils/sync-target.js',
]);

const SOURCE_EXT = /\.(js|mjs)$/;

/** Alle .js/.mjs-Dateien unter dir (rekursiv), als absolute Pfade. */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

/**
 * Liefert je import/export-from und dynamischem import() das Modul-Specifier
 * samt Zeilennummer. Deckt statische ES-Module und `import('…')` ab.
 */
function importSpecifiers(code) {
  const out = [];
  // static: import ... from '…'  |  export ... from '…'  |  import '…'
  const staticRe = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
  // dynamic: import('…')  — nur String-Literale (variable Specifier sind hier ohnehin selten)
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [staticRe, dynRe]) {
    let m;
    while ((m = re.exec(code)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const line = code.slice(0, m.index).split('\n').length;
      out.push({ spec, line });
    }
  }
  return out;
}

/** 'public' | 'server' | null für einen absoluten Pfad. */
function layerOf(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (rel === 'public' || rel.startsWith('public' + path.sep)) return 'public';
  if (rel === 'server' || rel.startsWith('server' + path.sep)) return 'server';
  return null;
}

/**
 * Löst einen relativen Specifier gegen die Datei auf und liefert den absoluten
 * Zielpfad — oder null für nicht-relative Specifier (node:*, npm, Browser-Root `/…`).
 * Nur relative Pfade können die Schichtgrenze überqueren; alles andere ist irrelevant.
 */
function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  return path.resolve(path.dirname(fromFile), spec);
}

test('public/ importiert niemals aus server/', () => {
  const violations = [];
  for (const file of sourceFiles(PUBLIC_DIR)) {
    const code = readFileSync(file, 'utf8');
    for (const { spec, line } of importSpecifiers(code)) {
      const target = resolveRelative(file, spec);
      if (target && layerOf(target) === 'server') {
        violations.push(`${path.relative(ROOT, file)}:${line} → importiert '${spec}' (server/)`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'Frontend-Code darf keine Server-Module importieren — die Logik gehört hinter die API:\n' +
      violations.join('\n'),
  );
});

test('server/ importiert aus public/ nur geteilte isomorphe Utils (Allowlist)', () => {
  const violations = [];
  for (const file of sourceFiles(SERVER_DIR)) {
    const code = readFileSync(file, 'utf8');
    for (const { spec, line } of importSpecifiers(code)) {
      const target = resolveRelative(file, spec);
      if (target && layerOf(target) === 'public') {
        const relTarget = path.relative(ROOT, target).split(path.sep).join('/');
        if (!SHARED_ISOMORPHIC.has(relTarget)) {
          violations.push(
            `${path.relative(ROOT, file)}:${line} → importiert '${spec}' (${relTarget})`,
          );
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'Backend darf aus public/ nur bewusst freigegebene isomorphe Utils importieren.\n' +
      'Ist das Modul wirklich isomorph (rein, ohne DOM/Node), in SHARED_ISOMORPHIC aufnehmen —\n' +
      'sonst die Logik ins Backend verschieben:\n' +
      violations.join('\n'),
  );
});
