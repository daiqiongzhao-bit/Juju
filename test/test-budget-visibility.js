/**
 * Modul: Budget-Sichtbarkeit (#476/#505) - Tests
 * Zweck: Owner-basiertes Sichtbarkeitsmodell (private/shared), Ansichts-Scope
 *        (mine/household) und Schreib-Berechtigung. KEIN Admin-Bypass.
 * Ausführen: node --experimental-sqlite test/test-budget-visibility.js
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import {
  BUDGET_VISIBILITY_VALUES,
  normalizeBudgetVisibility,
  budgetVisibilityWhere,
  budgetScopeWhere,
  canEditEntry,
} from '../server/services/budget-visibility.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

// ============================================================
// Reine Helfer
// ============================================================
console.log('\n[Budget-Visibility] Reine Helfer\n');

test('BUDGET_VISIBILITY_VALUES = [private, shared]', () => {
  assert(JSON.stringify(BUDGET_VISIBILITY_VALUES) === JSON.stringify(['private', 'shared']));
});

test('normalizeBudgetVisibility akzeptiert gültige Werte', () => {
  assert(normalizeBudgetVisibility('private') === 'private');
  assert(normalizeBudgetVisibility('shared') === 'shared');
});

test('normalizeBudgetVisibility fällt auf shared zurück', () => {
  assert(normalizeBudgetVisibility('bogus') === 'shared');
  assert(normalizeBudgetVisibility(undefined) === 'shared');
  assert(normalizeBudgetVisibility(null, 'private') === 'private');
});

test('budgetVisibilityWhere: shared-Modus = 1=1 (Altverhalten)', () => {
  assert(budgetVisibilityWhere('b', '@me', { mode: 'shared' }) === '1=1');
  assert(budgetVisibilityWhere('b', '@me', {}) === '1=1');
});

test('budgetVisibilityWhere: personal-Modus filtert shared ODER owner', () => {
  const frag = budgetVisibilityWhere('b', '@me', { mode: 'personal' });
  assert(/b\.visibility = 'shared'/.test(frag), frag);
  assert(/b\.owner_id = @me/.test(frag), frag);
});

test('budgetScopeWhere: mine → owner, household → shared', () => {
  assert(budgetScopeWhere('mine', 'b', '@me') === 'b.owner_id = @me');
  assert(budgetScopeWhere('household', 'b', '@me') === "b.visibility = 'shared'");
});

test('canEditEntry: Owner oder Ersteller darf, sonst nicht (kein Admin-Bypass)', () => {
  assert(canEditEntry({ owner_id: 5, created_by: 9 }, { id: 5 }) === true);
  assert(canEditEntry({ owner_id: 5, created_by: 9 }, { id: 9 }) === true);
  assert(canEditEntry({ owner_id: 5, created_by: 9 }, { id: 1 }) === false);
  assert(canEditEntry(null, { id: 5 }) === false);
});

// ============================================================
// Integration: Enforcement über echte SQL-Fragmente
// ============================================================
console.log('\n[Budget-Visibility] Enforcement (SQL)\n');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);

const A = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('a', 'A', 'x', 'member')`).run().lastInsertRowid;
const B = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('b', 'B', 'x', 'member')`).run().lastInsertRowid;
const ADMIN = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run().lastInsertRowid;

function addEntry(title, owner, visibility) {
  return db.prepare(`INSERT INTO budget_entries (title, amount, category, date, created_by, owner_id, visibility)
    VALUES (?, -10, 'Sonstiges', '2026-07-01', ?, ?, ?)`).run(title, owner, owner, visibility).lastInsertRowid;
}
const aPriv   = addEntry('A privat',   A, 'private');
const aShared = addEntry('A geteilt',  A, 'shared');
const bPriv   = addEntry('B privat',   B, 'private');

/** Liest sichtbare Einträge für viewer mit gegebenem Modus/Scope. */
function visibleIds(viewer, mode, scope) {
  let sql = `SELECT b.id FROM budget_entries b WHERE 1=1`;
  sql += ` AND ${budgetVisibilityWhere('b', '@me', { mode })}`;
  if (scope) sql += ` AND ${budgetScopeWhere(scope, 'b', '@me')}`;
  // node:sqlite lehnt unbenutzte benannte Parameter ab → nur binden, wenn referenziert.
  const params = sql.includes('@me') ? { me: viewer } : {};
  return db.prepare(sql).all(params).map(r => r.id);
}

test('personal-Modus: B sieht A privat NICHT, A geteilt schon', () => {
  const ids = visibleIds(B, 'personal');
  assert(!ids.includes(aPriv), 'B darf A privat nicht sehen');
  assert(ids.includes(aShared), 'B muss A geteilt sehen');
  assert(ids.includes(bPriv), 'B sieht eigenes privat');
});

test('personal-Modus: Admin sieht A privat AUCH NICHT (kein Bypass)', () => {
  const ids = visibleIds(ADMIN, 'personal');
  assert(!ids.includes(aPriv), 'Admin darf A privat nicht sehen');
  assert(!ids.includes(bPriv), 'Admin darf B privat nicht sehen');
  assert(ids.includes(aShared), 'Admin sieht geteilte Einträge');
});

test('shared-Modus: B sieht alles (Altverhalten)', () => {
  const ids = visibleIds(B, 'shared');
  assert(ids.includes(aPriv) && ids.includes(aShared) && ids.includes(bPriv), JSON.stringify(ids));
});

test('scope=mine: nur eigene Einträge von A', () => {
  const ids = visibleIds(A, 'personal', 'mine');
  assert(ids.includes(aPriv) && ids.includes(aShared), 'A sieht beide eigenen');
  assert(!ids.includes(bPriv), 'A sieht nicht B privat');
});

test('scope=household: nur der geteilte Topf', () => {
  const ids = visibleIds(A, 'personal', 'household');
  assert(ids.includes(aShared), 'geteilter Eintrag im Haushalt');
  assert(!ids.includes(aPriv) && !ids.includes(bPriv), 'keine privaten im Haushalt');
});

console.log(`\n[Budget-Visibility-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exit(1);
