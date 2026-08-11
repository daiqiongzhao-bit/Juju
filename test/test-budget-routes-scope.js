/**
 * Test: Budget-Routen im Personal-Modus (#476/#505)
 * Zweck: End-to-End über den echten Router — Default-Sichtbarkeit, Lese-Scope
 *        (mine/household), 403-Gates für fremde Einträge. Kein Admin-Bypass.
 * Ausführen: node --experimental-sqlite --test test/test-budget-routes-scope.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const db = dbmod.get();

// Zwei Mitglieder + ein Admin.
const A = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')`).run().lastInsertRowid;
const B = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('b','B','x','member')`).run().lastInsertRowid;
const ADMIN = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')`).run().lastInsertRowid;

function setMode(mode) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(mode);
}

let actor = { id: A, role: 'member' };
function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = actor.id; req.authRole = actor.role; req.session = { userId: actor.id }; next(); });
  app.use('/', budgetRouter);
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({
      baseUrl: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise((r) => s.close(r)),
    }));
  });
}

const MONTH = '2026-05';
async function createEntry(app, as, body) {
  actor = as;
  const res = await fetch(`${app.baseUrl}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: body.title, amount: -10, date: `${MONTH}-10`, ...body }),
  });
  return res;
}
async function listIds(app, as, scope) {
  actor = as;
  const q = scope ? `&scope=${scope}` : '';
  const res = await fetch(`${app.baseUrl}/?month=${MONTH}${q}`);
  const body = await res.json();
  return body.data.map((e) => ({ id: e.id, title: e.title, visibility: e.visibility, owner_id: e.owner_id }));
}

test('personal-Modus: neue Einträge sind default privat', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    const res = await createEntry(app, { id: A, role: 'member' }, { title: 'A default' });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.data.visibility, 'private');
    assert.equal(body.data.owner_id, A);
  } finally { await app.close(); }
});

test('personal-Modus: B sieht A privat NICHT, aber A geteilt', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    const priv = await (await createEntry(app, { id: A, role: 'member' }, { title: 'A priv', visibility: 'private' })).json();
    const shared = await (await createEntry(app, { id: A, role: 'member' }, { title: 'A shared', visibility: 'shared' })).json();

    // B in Haushalts-Ansicht: nur der geteilte Topf.
    const bHousehold = await listIds(app, { id: B, role: 'member' }, 'household');
    const bTitles = bHousehold.map((e) => e.title);
    assert.ok(bTitles.includes('A shared'), 'B sieht geteilt');
    assert.ok(!bTitles.includes('A priv'), 'B sieht A privat nicht');

    // Admin ebenfalls kein Zugriff auf A privat (kein Bypass).
    const adminHousehold = await listIds(app, { id: ADMIN, role: 'admin' }, 'household');
    assert.ok(!adminHousehold.map((e) => e.title).includes('A priv'), 'Admin sieht A privat nicht');

    // A in Mein-Ansicht: beide eigenen.
    const aMine = await listIds(app, { id: A, role: 'member' }, 'mine');
    const aTitles = aMine.map((e) => e.title);
    assert.ok(aTitles.includes('A priv') && aTitles.includes('A shared'), JSON.stringify(aTitles));

    void priv; void shared;
  } finally { await app.close(); }
});

test('personal-Modus: B darf A-Eintrag nicht ändern/löschen (403)', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    const entry = await (await createEntry(app, { id: A, role: 'member' }, { title: 'A own', visibility: 'shared' })).json();
    const eid = entry.data.id;

    actor = { id: B, role: 'member' };
    const put = await fetch(`${app.baseUrl}/${eid}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'hijack' }),
    });
    assert.equal(put.status, 403, 'B darf nicht bearbeiten');

    const del = await fetch(`${app.baseUrl}/${eid}`, { method: 'DELETE' });
    assert.equal(del.status, 403, 'B darf nicht löschen');

    // Admin ebenfalls nicht (kein Bypass): A privat.
    const priv = await (await createEntry(app, { id: A, role: 'member' }, { title: 'A secret', visibility: 'private' })).json();
    actor = { id: ADMIN, role: 'admin' };
    const adminDel = await fetch(`${app.baseUrl}/${priv.data.id}`, { method: 'DELETE' });
    assert.equal(adminDel.status, 403, 'Admin darf A privat nicht löschen');
  } finally { await app.close(); }
});

test('shared-Modus: B sieht und bearbeitet A-Eintrag (Altverhalten)', async () => {
  setMode('shared');
  const app = await startApp();
  try {
    const entry = await (await createEntry(app, { id: A, role: 'member' }, { title: 'shared-mode' })).json();
    const list = await listIds(app, { id: B, role: 'member' });
    assert.ok(list.map((e) => e.title).includes('shared-mode'), 'B sieht im shared-Modus');

    actor = { id: B, role: 'member' };
    const put = await fetch(`${app.baseUrl}/${entry.data.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'edited' }),
    });
    assert.equal(put.status, 200, 'B darf im shared-Modus bearbeiten');
  } finally { await app.close(); }
});
