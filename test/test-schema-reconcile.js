/**
 * Tests: Schema-Selbstheilung gegen Migrations-Drift (#538)
 * Modul: server/db.js → reconcileCriticalSchema()
 *
 * Szenario: Eine Migration (v54) ist in schema_migrations als angewendet vermerkt,
 * ihr additiver Effekt (reminders.pushed_at) fehlt real - etwa nach Restore aus
 * einem inkonsistenten Backup. Ohne die Spalte scheitert der Notification-/Push-
 * Scheduler bei jedem Lauf still auf `no such column: r.pushed_at`.
 *
 * Der Test läuft gegen eine eigene node:sqlite-DB (built-in) und beweist damit,
 * dass die Reparatur mit derselben API funktioniert wie in Produktion mit
 * better-sqlite3 (PRAGMA table_info + ALTER TABLE ADD COLUMN).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

// db.js initialisiert beim Import die globale (better-sqlite3-)DB; wir testen
// reconcileCriticalSchema aber isoliert gegen eine eigene node:sqlite-Instanz.
const { reconcileCriticalSchema } = await import('../server/db.js');

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

test('trägt fehlende reminders.pushed_at nach und erhält Bestandsdaten', () => {
  const db = new DatabaseSync(':memory:');
  // reminders wie in einer gedrifteten DB: ohne pushed_at
  db.exec(`CREATE TABLE reminders (
    id INTEGER PRIMARY KEY, entity_type TEXT, entity_id INTEGER,
    remind_at TEXT, dismissed INTEGER DEFAULT 0, created_by INTEGER, created_at TEXT
  )`);
  db.exec(`INSERT INTO reminders (id, entity_type, remind_at) VALUES (1, 'task', '2026-01-01T09:00:00Z')`);
  assert.equal(hasColumn(db, 'reminders', 'pushed_at'), false);

  reconcileCriticalSchema(db);

  assert.equal(hasColumn(db, 'reminders', 'pushed_at'), true);
  // Die neue Spalte ist NULL-defaultet, Bestandszeile bleibt erhalten
  const row = db.prepare('SELECT id, entity_type, pushed_at FROM reminders WHERE id = 1').get();
  assert.equal(row.entity_type, 'task');
  assert.equal(row.pushed_at, null);
  // Genau die Query des Schedulers ist danach lauffähig
  assert.doesNotThrow(() => db.prepare('SELECT id FROM reminders r WHERE r.pushed_at IS NULL').all());
});

test('ist idempotent: vorhandene Spalte samt Wert bleibt unangetastet', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE reminders (id INTEGER PRIMARY KEY, remind_at TEXT, pushed_at TEXT)`);
  db.exec(`INSERT INTO reminders (id, pushed_at) VALUES (1, '2026-05-05T10:00:00Z')`);

  reconcileCriticalSchema(db);
  reconcileCriticalSchema(db); // zweiter Lauf darf keinen Duplicate-Column-Fehler werfen

  const row = db.prepare('SELECT pushed_at FROM reminders WHERE id = 1').get();
  assert.equal(row.pushed_at, '2026-05-05T10:00:00Z');
});

test('ist ein No-op, wenn die reminders-Tabelle ganz fehlt (kein Wurf, keine Neuanlage)', () => {
  const db = new DatabaseSync(':memory:');
  assert.doesNotThrow(() => reconcileCriticalSchema(db));
  const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reminders'").get();
  assert.equal(tbl, undefined);
});

test('greift ohne database-Argument nicht auf eine nicht-initialisierte DB zu', () => {
  // Defensive: reconcileCriticalSchema(undefined) bei fehlender globaler DB darf nicht werfen.
  assert.doesNotThrow(() => reconcileCriticalSchema(null));
});
