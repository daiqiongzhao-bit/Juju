/**
 * Modul: Tasks-Routen (Härtung)
 * Zweck: End-to-End über den echten Router - die zuvor ungetesteten
 *        Zweige: PUT /:id (Vollupdate inkl. Zuweisungs-Replace, Punkte-Clamp,
 *        Sichtbarkeit, Housekeeping-/Reward-Kopplung), GET /meta/options,
 *        Kategorie-Umbenennen/Löschen (404/400/409), Listen-Filter, POST-
 *        Verschachtelung (Parent-404, Tiefenlimit), PATCH-Status (400/404),
 *        DELETE (404). Die Feature-Suiten (recurrence, multi-assignment,
 *        visibility, task-documents) decken andere Aspekte ab; hier geht es um
 *        die Route-/Validierungs-Schicht.
 * Ausführen: npm run test:tasks-routes
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'tasks-routes-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

function applyMigration(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
  database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(database, migration);
  return database;
}

function seedUser(prefix, role = 'member') {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'hash', '#007AFF', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

const ALICE = seedUser('alice', 'admin');
const BOB   = seedUser('bob', 'member');
const WORKER = seedUser('worker', 'member');
// Housekeeping-Kraft: muss aus /meta/options-Nutzern ausgeschlossen werden.
db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 0)').run(WORKER);

// Aktueller Akteur (Middleware liest ihn zur Request-Zeit).
let actor = { id: ALICE, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;

test.after(() => { server.close(); db.close(); });

async function call(method, path, { as, body } = {}) {
  if (as) actor = as;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Eine gültige Kategorie fixieren (aus den migrierten Defaults).
let CATEGORY;
test('setup: Default-Kategorien vorhanden', async () => {
  const r = await call('GET', '/categories', { as: { id: ALICE, role: 'admin' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 2);
  CATEGORY = r.body.data[0].key;
});

// --------------------------------------------------------
// POST: Punkte-Clamp, Verschachtelung (Parent-404, Tiefenlimit)
// --------------------------------------------------------
let PARENT, SUB;
test('POST: Punkte über dem Maximum werden auf 10000 geklemmt', async () => {
  const r = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Viele Punkte', points: 99999 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.points, 10000);
});

test('POST: Subtask unter Parent erlaubt; unbekannter Parent → 404', async () => {
  const parent = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Elternaufgabe', category: CATEGORY } });
  PARENT = parent.body.data.id;
  const sub = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Unteraufgabe', parent_task_id: PARENT } });
  assert.equal(sub.status, 201);
  SUB = sub.body.data.id;
  const missing = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Waise', parent_task_id: 999999 } });
  assert.equal(missing.status, 404);
});

test('POST: dritte Verschachtelungsebene → 400', async () => {
  const r = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Zu tief', parent_task_id: SUB } });
  assert.equal(r.status, 400);
});

test('POST: ungültige Priorität → 400', async () => {
  const r = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'X', priority: 'sofort' } });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------
// GET-Filter + GET /:id
// --------------------------------------------------------
test('GET /: Filter status/priority/category/assigned_to greifen', async () => {
  await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Dringend offen', priority: 'urgent', status: 'open', category: CATEGORY, assigned_to: [BOB] } });
  const byStatus = await call('GET', '/?status=open', { as: { id: ALICE, role: 'admin' } });
  assert.ok(byStatus.body.data.every((t) => t.status === 'open'));
  const byPriority = await call('GET', '/?priority=urgent', { as: { id: ALICE, role: 'admin' } });
  assert.ok(byPriority.body.data.some((t) => t.title === 'Dringend offen'));
  const byCategory = await call('GET', `/?category=${CATEGORY}`, { as: { id: ALICE, role: 'admin' } });
  assert.ok(byCategory.body.data.every((t) => t.category === CATEGORY));
  const byAssignee = await call('GET', `/?assigned_to=${BOB}`, { as: { id: ALICE, role: 'admin' } });
  assert.ok(byAssignee.body.data.some((t) => t.title === 'Dringend offen'));
});

test('GET /: include_future blendet zukünftige Startdaten ein/aus', async () => {
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const created = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Zukunfts-Task', start_date: future } });
  const fid = created.body.data.id;
  const def = await call('GET', '/', { as: { id: ALICE, role: 'admin' } });
  assert.ok(!def.body.data.some((t) => t.id === fid), 'zukünftige Aufgabe standardmäßig ausgeblendet');
  const withFuture = await call('GET', '/?include_future=1', { as: { id: ALICE, role: 'admin' } });
  assert.ok(withFuture.body.data.some((t) => t.id === fid), 'mit include_future sichtbar');
});

test('GET /:id: unbekannte ID → 404', async () => {
  const r = await call('GET', '/999999', { as: { id: ALICE, role: 'admin' } });
  assert.equal(r.status, 404);
});

// --------------------------------------------------------
// PUT /:id: Vollupdate, Zuweisungs-Replace, Sichtbarkeit, Punkte
// --------------------------------------------------------
test('PUT /:id: aktualisiert Felder, ersetzt Zuweisungen, klemmt Punkte', async () => {
  const created = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Ur-Titel', category: CATEGORY, assigned_to: [ALICE] } });
  const id = created.body.data.id;
  const r = await call('PUT', `/${id}`, {
    as: { id: ALICE, role: 'admin' },
    body: { title: 'Neu-Titel', description: 'Beschreibung', priority: 'high', status: 'in_progress', category: CATEGORY, assigned_to: [BOB], points: 99999, visibility: 'all' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.title, 'Neu-Titel');
  assert.equal(r.body.data.priority, 'high');
  assert.equal(r.body.data.status, 'in_progress');
  assert.equal(r.body.data.points, 10000, 'Punkte geklemmt');
  assert.equal(r.body.data.assigned_users.length, 1);
  assert.equal(r.body.data.assigned_users[0].id, BOB, 'Zuweisung ersetzt');
  assert.ok(Array.isArray(r.body.data.subtasks));
});

test('PUT /:id: ohne assigned_to bleiben bestehende Zuweisungen erhalten', async () => {
  const created = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Behalte-Zuweisung', assigned_to: [ALICE, BOB] } });
  const id = created.body.data.id;
  const r = await call('PUT', `/${id}`, { as: { id: ALICE, role: 'admin' }, body: { title: 'Nur Titel neu' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.assigned_users.length, 2, 'Zuweisungen unverändert');
});

test('PUT /:id: unbekannte ID → 404, ungültiger Status → 400', async () => {
  const missing = await call('PUT', '/999999', { as: { id: ALICE, role: 'admin' }, body: { title: 'X' } });
  assert.equal(missing.status, 404);
  const created = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Statusprobe' } });
  const bad = await call('PUT', `/${created.body.data.id}`, { as: { id: ALICE, role: 'admin' }, body: { status: 'erledigt-vielleicht' } });
  assert.equal(bad.status, 400);
});

// --------------------------------------------------------
// PATCH /:id/status, DELETE /:id
// --------------------------------------------------------
test('PATCH /:id/status: ungültiger Status → 400, unbekannte ID → 404', async () => {
  const bad = await call('PATCH', '/1/status', { as: { id: ALICE, role: 'admin' }, body: { status: 'quatsch' } });
  assert.equal(bad.status, 400);
  const missing = await call('PATCH', '/999999/status', { as: { id: ALICE, role: 'admin' }, body: { status: 'done' } });
  assert.equal(missing.status, 404);
});

test('PATCH /:id/status: gültiger Wechsel persistiert', async () => {
  const created = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Statuswechsel' } });
  const id = created.body.data.id;
  const r = await call('PATCH', `/${id}/status`, { as: { id: ALICE, role: 'admin' }, body: { status: 'done' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'done');
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id);
  assert.equal(row.status, 'done');
});

test('DELETE /:id: Erfolg (204/ok) und unbekannte ID → 404', async () => {
  const created = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Löschbar' } });
  const del = await call('DELETE', `/${created.body.data.id}`, { as: { id: ALICE, role: 'admin' } });
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);
  const missing = await call('DELETE', '/999999', { as: { id: ALICE, role: 'admin' } });
  assert.equal(missing.status, 404);
});

// --------------------------------------------------------
// GET /meta/options
// --------------------------------------------------------
test('GET /meta/options: Nutzer (ohne Housekeeping-Kraft) + Enum-Listen', async () => {
  const r = await call('GET', '/meta/options', { as: { id: ALICE, role: 'admin' } });
  assert.equal(r.status, 200);
  const ids = r.body.users.map((u) => u.id);
  assert.ok(ids.includes(ALICE) && ids.includes(BOB));
  assert.ok(!ids.includes(WORKER), 'Housekeeping-Kraft ausgeschlossen');
  assert.deepEqual(r.body.priorities, ['none', 'low', 'medium', 'high', 'urgent']);
  assert.deepEqual(r.body.statuses, ['open', 'in_progress', 'done', 'archived']);
  assert.ok(Array.isArray(r.body.categories) && r.body.categories.length >= 2);
});

// --------------------------------------------------------
// Kategorie umbenennen / löschen (404/400/409)
// --------------------------------------------------------
test('PUT /categories/:key: umbenennen, 404, leerer Name 400, Konflikt 409', async () => {
  // Zwei frische Kategorien anlegen, um Konflikt/Umbenennung isoliert zu prüfen.
  const a = await call('POST', '/categories', { as: { id: ALICE, role: 'admin' }, body: { name: 'Kat-Alpha' } });
  const b = await call('POST', '/categories', { as: { id: ALICE, role: 'admin' }, body: { name: 'Kat-Beta' } });
  assert.equal(a.status, 201);

  const renamed = await call('PUT', `/categories/${a.body.data.key}`, { as: { id: ALICE, role: 'admin' }, body: { name: 'Kat-Alpha-2' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.name, 'Kat-Alpha-2');
  assert.equal(renamed.body.data.label_key, null);

  const missing = await call('PUT', '/categories/gibtsnicht', { as: { id: ALICE, role: 'admin' }, body: { name: 'X' } });
  assert.equal(missing.status, 404);

  const empty = await call('PUT', `/categories/${a.body.data.key}`, { as: { id: ALICE, role: 'admin' }, body: { name: '' } });
  assert.equal(empty.status, 400);

  const conflict = await call('PUT', `/categories/${a.body.data.key}`, { as: { id: ALICE, role: 'admin' }, body: { name: 'Kat-Beta' } });
  assert.equal(conflict.status, 409);
});

test('DELETE /categories/:key: 404, in Benutzung 409, danach Erfolg', async () => {
  const cat = await call('POST', '/categories', { as: { id: ALICE, role: 'admin' }, body: { name: 'Kat-Weg' } });
  const key = cat.body.data.key;

  const missing = await call('DELETE', '/categories/gibtsnicht', { as: { id: ALICE, role: 'admin' } });
  assert.equal(missing.status, 404);

  // In Benutzung: eine Aufgabe referenziert die Kategorie.
  const task = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Nutzt Kat', category: key } });
  const inUse = await call('DELETE', `/categories/${key}`, { as: { id: ALICE, role: 'admin' } });
  assert.equal(inUse.status, 409);
  assert.equal(inUse.body.reason, 'category_in_use');

  // Referenz lösen, dann löschbar.
  await call('DELETE', `/${task.body.data.id}`, { as: { id: ALICE, role: 'admin' } });
  const ok = await call('DELETE', `/categories/${key}`, { as: { id: ALICE, role: 'admin' } });
  assert.equal(ok.status, 204);
});

// --------------------------------------------------------
// GET /: Mehrfachauswahl je Achse (#671)
//
// Gemeldet: "Filtering the tasklist for e.g. priority only allows one value to
// be filtered by per row/attribute". Innerhalb einer Achse muss ODER gelten -
// eine Aufgabe trägt genau EINE Priorität, ein UND wäre garantiert leer.
// Zwischen den Achsen bleibt es UND.
// --------------------------------------------------------
test('GET /: mehrere Prioritäten verknüpfen sich ODER', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const mk = (title, priority, status = 'open') =>
    call('POST', '/', { as: admin, body: { title, priority, status } });

  const marker = `prio-${randomUUID().slice(0, 8)}`;
  await mk(`${marker}-hoch`, 'high');
  await mk(`${marker}-mittel`, 'medium');
  await mk(`${marker}-niedrig`, 'low');

  const mine = (rows) => rows.filter((r) => r.title.startsWith(marker)).map((r) => r.priority).sort();

  const single = await call('GET', '/?priority=high', { as: admin });
  assert.deepEqual(mine(single.body.data), ['high'], 'ein Wert filtert wie bisher');

  const both = await call('GET', '/?priority=high&priority=medium', { as: admin });
  assert.deepEqual(mine(both.body.data), ['high', 'medium'], 'zwei Werte liefern beide Gruppen');

  const all = await call('GET', '/?priority=high&priority=medium&priority=low', { as: admin });
  assert.deepEqual(mine(all.body.data), ['high', 'low', 'medium']);
});

test('GET /: mehrere Status verknüpfen sich ODER, Achsen untereinander UND', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const marker = `mix-${randomUUID().slice(0, 8)}`;
  await call('POST', '/', { as: admin, body: { title: `${marker}-a`, status: 'open', priority: 'high' } });
  await call('POST', '/', { as: admin, body: { title: `${marker}-b`, status: 'in_progress', priority: 'high' } });
  await call('POST', '/', { as: admin, body: { title: `${marker}-c`, status: 'in_progress', priority: 'low' } });

  const titles = (rows) => rows.filter((r) => r.title.startsWith(marker)).map((r) => r.title).sort();

  const twoStatus = await call('GET', '/?status=open&status=in_progress', { as: admin });
  assert.deepEqual(titles(twoStatus.body.data), [`${marker}-a`, `${marker}-b`, `${marker}-c`]);

  // Achsen-Kombination engt ein: (open ODER in_progress) UND Priorität hoch.
  const narrowed = await call('GET', '/?status=open&status=in_progress&priority=high', { as: admin });
  assert.deepEqual(titles(narrowed.body.data), [`${marker}-a`, `${marker}-b`]);
});

test('GET /: mehrere Personen verknüpfen sich ODER', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const marker = `wer-${randomUUID().slice(0, 8)}`;
  await call('POST', '/', { as: admin, body: { title: `${marker}-alice`, assigned_to: ALICE } });
  await call('POST', '/', { as: admin, body: { title: `${marker}-bob`, assigned_to: BOB } });
  await call('POST', '/', { as: admin, body: { title: `${marker}-niemand` } });

  const titles = (rows) => rows.filter((r) => r.title.startsWith(marker)).map((r) => r.title).sort();

  const one = await call('GET', `/?assigned_to=${BOB}`, { as: admin });
  assert.deepEqual(titles(one.body.data), [`${marker}-bob`]);

  const two = await call('GET', `/?assigned_to=${ALICE}&assigned_to=${BOB}`, { as: admin });
  assert.deepEqual(titles(two.body.data), [`${marker}-alice`, `${marker}-bob`]);
});

test('GET /: ein leerer oder unsinniger Wert engt nicht versehentlich ein', async () => {
  const admin = { id: ALICE, role: 'admin' };
  // Ein leerer Parameter darf nicht als Wert "" gelten und alles wegfiltern.
  const empty = await call('GET', '/?priority=', { as: admin });
  const unfiltered = await call('GET', '/', { as: admin });
  assert.equal(empty.body.data.length, unfiltered.body.data.length);

  // Eine nicht-numerische Person wird verworfen, statt die Query zu sprengen.
  const bogus = await call('GET', '/?assigned_to=abc', { as: admin });
  assert.equal(bogus.status, 200);
  assert.equal(bogus.body.data.length, unfiltered.body.data.length);
});

// --------------------------------------------------------
// Archiv als eigene Achse (#688)
//
// Gemeldet war: eine erledigte Aufgabe kam nach dem Archivieren als unerledigt
// zurück und stand danach in "Heute auf einen Blick", wo sie sich nicht öffnen
// ließ. Ursache war ein überladenes Statusfeld - das Ablegen überschrieb das
// Erledigt-Sein. Diese Tests halten die Trennung fest.
// --------------------------------------------------------
test('Archivieren lässt den Status stehen - auch erledigt bleibt erledigt', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const created = await call('POST', '/', { as: admin, body: { title: `arch-${randomUUID().slice(0, 8)}` } });
  const id = created.body.data.id;

  await call('PATCH', `/${id}/status`, { as: admin, body: { status: 'done' } });
  const archived = await call('PATCH', `/${id}/archive`, { as: admin, body: { archived: true } });

  assert.equal(archived.status, 200);
  assert.equal(archived.body.data.status, 'done', 'der Status darf sich beim Ablegen nicht ändern');
  assert.ok(archived.body.data.archived_at, 'archived_at wird gesetzt');

  const row = await call('GET', `/${id}`, { as: admin });
  assert.equal(row.body.data.status, 'done');
  assert.ok(row.body.data.archived_at);
});

test('PATCH /status mit "archived" legt ab, statt den Status zu überschreiben', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const created = await call('POST', '/', { as: admin, body: { title: `legacy-${randomUUID().slice(0, 8)}` } });
  const id = created.body.data.id;
  await call('PATCH', `/${id}/status`, { as: admin, body: { status: 'done' } });

  // Der Weg, den Bestandsclients und die MCP-Brücke nehmen.
  const r = await call('PATCH', `/${id}/status`, { as: admin, body: { status: 'archived' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'done');
  assert.ok(r.body.data.archived_at);

  // Dasselbe über das Vollupdate.
  const other = await call('POST', '/', { as: admin, body: { title: `legacy-put-${randomUUID().slice(0, 8)}` } });
  await call('PATCH', `/${other.body.data.id}/status`, { as: admin, body: { status: 'in_progress' } });
  const put = await call('PUT', `/${other.body.data.id}`, { as: admin, body: { title: 'unverändert', status: 'archived' } });
  assert.equal(put.body.data.status, 'in_progress');
  assert.ok(put.body.data.archived_at);
});

test('Zurückholen setzt den Status nicht zurück', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const created = await call('POST', '/', { as: admin, body: { title: `back-${randomUUID().slice(0, 8)}` } });
  const id = created.body.data.id;
  await call('PATCH', `/${id}/status`, { as: admin, body: { status: 'done' } });
  await call('PATCH', `/${id}/archive`, { as: admin, body: { archived: true } });

  const back = await call('PATCH', `/${id}/archive`, { as: admin, body: { archived: false } });
  assert.equal(back.body.data.status, 'done', 'gemeldet war genau das Gegenteil: sie kam als offen zurück');
  assert.equal(back.body.data.archived_at, null);
});

test('GET /: Abgelegtes bleibt draußen, bis danach gefragt wird', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const marker = `sicht-${randomUUID().slice(0, 8)}`;
  await call('POST', '/', { as: admin, body: { title: `${marker}-offen` } });
  const b = await call('POST', '/', { as: admin, body: { title: `${marker}-abgelegt` } });
  await call('PATCH', `/${b.body.data.id}/archive`, { as: admin, body: { archived: true } });

  const titles = (rows) => rows.filter((r) => r.title.startsWith(marker)).map((r) => r.title).sort();

  const plain = await call('GET', '/', { as: admin });
  assert.deepEqual(titles(plain.body.data), [`${marker}-offen`]);

  // Der Statusfilter allein holt die abgelegte Aufgabe NICHT zurück, obwohl sie
  // weiter auf 'open' steht - genau daran hing die Beobachtung im Dashboard.
  const byStatus = await call('GET', '/?status=open', { as: admin });
  assert.deepEqual(titles(byStatus.body.data), [`${marker}-offen`]);

  const included = await call('GET', '/?archived=1', { as: admin });
  assert.deepEqual(titles(included.body.data), [`${marker}-abgelegt`, `${marker}-offen`]);

  const only = await call('GET', '/?archived=only', { as: admin });
  assert.deepEqual(titles(only.body.data), [`${marker}-abgelegt`]);

  // Der Filterchip der Oberfläche spricht weiter über den Statusparameter.
  const chip = await call('GET', '/?status=archived', { as: admin });
  assert.deepEqual(titles(chip.body.data), [`${marker}-abgelegt`]);

  // Und kombiniert bleibt es eine ODER-Achse wie jede andere.
  const both = await call('GET', '/?status=open&status=archived', { as: admin });
  assert.deepEqual(titles(both.body.data), [`${marker}-abgelegt`, `${marker}-offen`]);
});

test('Ablegen storniert keine Punkte-Gutschrift', async () => {
  const admin = { id: ALICE, role: 'admin' };
  db.prepare('INSERT OR REPLACE INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(BOB);

  const created = await call('POST', '/', { as: admin, body: { title: `punkte-${randomUUID().slice(0, 8)}`, points: 7, assigned_to: [BOB] } });
  const id = created.body.data.id;
  await call('PATCH', `/${id}/status`, { as: admin, body: { status: 'done' } });

  const earned = () => db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM reward_ledger WHERE task_id = ? AND type = 'earn'").get(id).n;
  assert.equal(earned(), 7, 'Erledigen bucht');

  await call('PATCH', `/${id}/archive`, { as: admin, body: { archived: true } });
  assert.equal(earned(), 7, 'Ablegen ist keine Rücknahme des Erledigens');
});
