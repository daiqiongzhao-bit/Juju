/**
 * Modul: Google Calendar Multi-Kalender – Unit-Tests
 * Zweck: Auswahltabelle, pro-Kalender-Sync-Token, Single→Multi-Migration,
 *        Outbound-Ziel-Validierung.
 * Ausführen: node test/test-google-multi.js
 */
process.env.DB_PATH = ':memory:';
// auth.js (via Route-Import in Task 5) erwartet SESSION_SECRET.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const db = (await import('../server/db.js')).get();

// Seed-User (created_by = 1 für eingefügte calendar_events / FK auf users)
db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log('\n[Google Multi] Schema + Migration\n');

test('google_calendar_selection table exists with expected columns', () => {
  const cols = db.prepare(`PRAGMA table_info(google_calendar_selection)`).all().map(c => c.name);
  for (const c of ['calendar_id', 'name', 'color', 'enabled', 'sync_token', 'last_sync']) {
    assert(cols.includes(c), `Spalte ${c} fehlt`);
  }
});

test('calendar_events has target_google_calendar_id column', () => {
  const cols = db.prepare(`PRAGMA table_info(calendar_events)`).all().map(c => c.name);
  assert(cols.includes('target_google_calendar_id'), 'target_google_calendar_id fehlt');
});

const svc = await import('../server/services/google-calendar.js');
const { __test } = svc;

function seedConnected() {
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_access_token','a')").run();
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_refresh_token','r')").run();
}

console.log('\n[Google Multi] Selection helpers\n');

test('setCalendarEnabled inserts an enabled selection row', () => {
  db.prepare('DELETE FROM google_calendar_selection').run();
  __test.setCalendarEnabled('fam@group.calendar.google.com', true, { name: 'Familie', color: '#34A853' });
  const rows = __test.listSelection();
  assertEqual(rows.length, 1);
  assertEqual(rows[0].calendar_id, 'fam@group.calendar.google.com');
  assertEqual(rows[0].enabled, 1);
  assertEqual(rows[0].name, 'Familie');
});

test('setCalendarEnabled(false) clears the calendar sync_token and removes its events', () => {
  db.prepare('DELETE FROM google_calendar_selection').run();
  db.prepare("DELETE FROM external_calendars").run();
  db.prepare("DELETE FROM calendar_events").run();
  const calRefId = __test.upsertExternalCalendar('google', 'kids@g', 'Kids', '#FF0000');
  __test.setCalendarEnabled('kids@g', true, { name: 'Kids', color: '#FF0000' });
  db.prepare("UPDATE google_calendar_selection SET sync_token = 'tok' WHERE calendar_id = 'kids@g'").run();
  db.prepare(`INSERT INTO calendar_events
    (title, start_datetime, external_calendar_id, external_source, calendar_ref_id, created_by)
    VALUES ('X', '2026-06-01T10:00', 'gev1', 'google', ?, 1)`).run(calRefId);

  __test.setCalendarEnabled('kids@g', false);

  const row = db.prepare("SELECT enabled, sync_token FROM google_calendar_selection WHERE calendar_id = 'kids@g'").get();
  assertEqual(row.enabled, 0);
  assertEqual(row.sync_token, null);
  const remaining = db.prepare("SELECT COUNT(*) c FROM calendar_events WHERE calendar_ref_id = ?").get(calRefId).c;
  assertEqual(remaining, 0, 'Events des deaktivierten Kalenders müssen gelöscht sein');
});

test('recordSyncToken persists a per-calendar token + last_sync', () => {
  db.prepare('DELETE FROM google_calendar_selection').run();
  __test.setCalendarEnabled('a@g', true, { name: 'A', color: null });
  __test.recordSyncToken('a@g', 'newtoken');
  const row = db.prepare("SELECT sync_token, last_sync FROM google_calendar_selection WHERE calendar_id = 'a@g'").get();
  assertEqual(row.sync_token, 'newtoken');
  assert(row.last_sync, 'last_sync muss gesetzt sein');
});

console.log('\n[Google Multi] Outbound-Ziel-Validierung\n');

const routes = await import('../server/routes/calendar.js');
const googleTarget = routes.__test?.googleTarget;

test('googleTarget: leeres Ziel → null (lokal)', () => {
  assertEqual(googleTarget({ target_google_calendar_id: '' }).value, null);
  assertEqual(googleTarget({}).value, null);
});

test('googleTarget: gültige ID wird durchgereicht (getrimmt)', () => {
  assertEqual(googleTarget({ target_google_calendar_id: ' fam@g ' }).value, 'fam@g');
});

test('googleTarget: zu lange ID → Fehler', () => {
  const long = 'x'.repeat(2049);
  assert(googleTarget({ target_google_calendar_id: long }).error, 'sollte Fehler liefern');
});

console.log('\n[Google Multi] accessRole-Filter\n');

test('isWritableRole: owner/writer → true', () => {
  assertEqual(__test.isWritableRole('owner'), true);
  assertEqual(__test.isWritableRole('writer'), true);
});

test('isWritableRole: reader/freeBusyReader/undefined/null → false', () => {
  assertEqual(__test.isWritableRole('reader'), false);
  assertEqual(__test.isWritableRole('freeBusyReader'), false);
  assertEqual(__test.isWritableRole(undefined), false);
  assertEqual(__test.isWritableRole(null), false);
});

console.log(`\n[Google Multi] ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
