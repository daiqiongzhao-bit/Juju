/**
 * Test: Modul-Register-Parität Client ↔ Server
 * Zweck: Mehrere Client-Listen spiegeln serverseitig gepflegte Modul-Register.
 *        Jede trägt einen Kommentar „muss zu server/… passen" - und dieser
 *        Kommentar war bislang die einzige Durchsetzung. Beim Einbau des
 *        Vorrats-Moduls (#596) war der Server lückenlos verdrahtet, während
 *        ALLE sechs Client-Zwillinge durchrutschten: nicht vergebbare API-Scopes,
 *        ein nicht greifendes Nav-Gate, ein Modul außerhalb der Küchen-Gruppe,
 *        ein fehlender Akzentpunkt und ein offline ungestyltes Stylesheet.
 *
 *        Dieser Guard prüft die Spiegelung mechanisch statt kommentarisch.
 *        Er ist bewusst als Mengen-Vergleich formuliert: ein neues Modul fällt
 *        dadurch beim ersten Testlauf auf, egal welche Liste vergessen wurde.
 * Ausführen: node --test test/test-module-registry-parity.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const { MODULE_KEYS } = await import('../server/scopes.js');
const { PERMISSION_MODULES } = await import('../server/permissions.js');
const { KITCHEN_CHILD_IDS } = await import('../public/settings/module-order.js');

/**
 * Liest ein Array-Literal aus einer Frontend-Quelldatei.
 * Die Settings-Seiten importieren Browser-Module (`/api.js` & Co.) und lassen
 * sich in Node nicht laden - deshalb Textextraktion statt Import.
 */
function arrayLiteral(source, name) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  assert.ok(match, `${name} nicht gefunden`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Liest die Schlüssel eines Objekt-Literals aus einer Frontend-Quelldatei. */
function objectKeys(source, name) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*(?:Object\\.freeze\\()?\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `${name} nicht gefunden`);
  return [...match[1].matchAll(/^\s*([A-Za-z_][\w-]*)\s*:/gm)].map((m) => m[1]);
}

// --------------------------------------------------------------------------
// Scopes: die API-Token-Oberfläche muss jeden scopebaren Modulschlüssel kennen
// --------------------------------------------------------------------------
test('admin-api.js SCOPE_MODULE_KEYS deckt jeden Scope-Modulschlüssel ab', () => {
  const client = arrayLiteral(read('../public/settings/pages/admin-api.js'), 'SCOPE_MODULE_KEYS');
  const missing = MODULE_KEYS.filter((key) => !client.includes(key));
  const extra = client.filter((key) => !MODULE_KEYS.includes(key));

  assert.deepEqual(missing, [], 'Scopes ohne UI: diese Module lassen sich nicht an ein Token vergeben');
  assert.deepEqual(extra, [], 'UI bietet Scopes an, die der Server nicht kennt');
});

// --------------------------------------------------------------------------
// Nav-Gate: jede navId eines gateable Moduls braucht ihre Zuordnung im Client
// --------------------------------------------------------------------------
test('permissions.js NAV_TO_MODULE kennt jede navId aus PERMISSION_MODULES', () => {
  const client = objectKeys(read('../public/permissions.js'), 'NAV_TO_MODULE');
  const navIds = PERMISSION_MODULES.flatMap((m) => m.navIds);
  const missing = navIds.filter((id) => !client.includes(id));

  // canAccessNavModule() gibt für unbekannte Keys `true` zurück - ein fehlender
  // Eintrag sperrt also nichts, sondern zeigt das Modul trotz Recht "none".
  assert.deepEqual(missing, [], 'ungegatete navIds: das Modul bleibt trotz Recht "none" sichtbar');
});

test('admin-permissions.js MODULE_ACCENT deckt jedes Permissions-Modul ab', () => {
  const client = objectKeys(read('../public/settings/pages/admin-permissions.js'), 'MODULE_ACCENT');
  const missing = PERMISSION_MODULES.map((m) => m.key).filter((key) => !client.includes(key));

  assert.deepEqual(missing, [], 'Module ohne Akzentpunkt in der Rechte-Verwaltung');
});

// --------------------------------------------------------------------------
// Küchen-Gruppe: drei Listen müssen sich gemeinsam bewegen
// --------------------------------------------------------------------------
test('die drei Kitchen-Child-Listen tragen dieselben IDs', () => {
  const navSource = read('../public/settings/pages/modules-navigation.js');
  const labels = objectKeys(navSource, 'KITCHEN_CHILD_LABEL_KEYS');
  const icons = objectKeys(navSource, 'KITCHEN_CHILD_ICONS');

  // Fehlt eine ID in den Labels, rendert der Nav-Editor `t(undefined)`.
  assert.deepEqual(labels, [...KITCHEN_CHILD_IDS], 'KITCHEN_CHILD_LABEL_KEYS weicht ab');
  assert.deepEqual(icons, [...KITCHEN_CHILD_IDS], 'KITCHEN_CHILD_ICONS weicht ab');
});

test('server KITCHEN_NAV_IDS enthält jedes Kitchen-Kind des Clients', () => {
  const source = read('../server/routes/preferences.js');
  const match = source.match(/KITCHEN_NAV_IDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, 'KITCHEN_NAV_IDS nicht gefunden');
  const serverIds = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const missing = KITCHEN_CHILD_IDS.filter((id) => !serverIds.includes(id));
  assert.deepEqual(missing, [], 'Kitchen-Kind fehlt in der serverseitigen Nav-Validierung');
});

// --------------------------------------------------------------------------
// Service Worker: jedes Modul mit eigenem Stylesheet gehört in die App-Shell,
// sonst rendert die Seite offline unformatiert
// --------------------------------------------------------------------------
// Auf die Deklarationen ankern, nicht auf den ersten Namenstreffer: beide
// Konstanten werden im Kopfkommentar der Datei erwähnt.
function swArray(sw, name) {
  const start = sw.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `const ${name} = [ nicht gefunden`);
  const end = sw.indexOf('];', start);
  assert.notEqual(end, -1, `Ende von ${name} nicht gefunden`);
  return sw.slice(start, end);
}

test('sw.js APP_SHELL cacht das Stylesheet jedes Kitchen-Moduls', () => {
  const shell = swArray(read('../public/sw.js'), 'APP_SHELL');

  for (const id of KITCHEN_CHILD_IDS) {
    assert.ok(
      shell.includes(`'/styles/${id}.css'`),
      `/styles/${id}.css fehlt in APP_SHELL - die Seite rendert offline ungestylt`
    );
  }
});

test('sw.js PAGE_MODULES cacht die Seite jedes Kitchen-Moduls', () => {
  const modules = swArray(read('../public/sw.js'), 'PAGE_MODULES');

  for (const id of KITCHEN_CHILD_IDS) {
    assert.ok(
      modules.includes(`'/pages/${id}.js'`),
      `/pages/${id}.js fehlt in PAGE_MODULES`
    );
  }
});

// --------------------------------------------------------------------------
// Toggle-Register: was der Nav-Editor als Kitchen-Kind führt, muss auch
// abschaltbar sein - sonst hat die Gruppe ein Kind ohne Schalter
// --------------------------------------------------------------------------
test('TOGGLEABLE_MODULES enthält jedes Kitchen-Kind', () => {
  const source = read('../server/routes/preferences.js');
  const match = source.match(/TOGGLEABLE_MODULES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(match, 'TOGGLEABLE_MODULES nicht gefunden');
  const toggleable = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const missing = KITCHEN_CHILD_IDS.filter((id) => !toggleable.includes(id));
  assert.deepEqual(missing, [], 'Kitchen-Kind ohne Abschalt-Möglichkeit');
});
