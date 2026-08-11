/**
 * Test-Suite: Datenbank-Verschlüsselung (DB_ENCRYPTION_KEY).
 *
 * Hintergrund: Bis v1.52.x war `DB_ENCRYPTION_KEY` faktisch wirkungslos — das
 * ausgelieferte Binary hatte keine Cipher-Schicht, reguläres SQLite ignorierte
 * das unbekannte `PRAGMA key` kommentarlos, und die App lief still auf einer
 * unverschlüsselten Datenbank weiter. Diese Suite hält fest, dass genau das
 * nicht mehr passieren kann.
 *
 * Geprüft wird bewusst gegen den Dateikopf auf der Platte statt gegen eine
 * API-Zusage: eine unverschlüsselte SQLite-Datei beginnt mit
 * "SQLite format 3\0", eine verschlüsselte mit Zufallsrauschen.
 *
 * Jedes Szenario lädt eine frische db.js-Instanz (dynamischer Import mit
 * Cache-Busting-Query), da DB_PATH und DB_ENCRYPTION_KEY beim Modul-Load aus
 * der Env gelesen werden.
 *
 * Lauf: node --experimental-sqlite test/test-db-encryption.js
 *   (bzw. npm run test:db-encryption)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

const KEY = 'test-encryption-key-0123456789';
const PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'binary');

let scenarioCounter = 0;

/** Frische db.js-Instanz mit gegebenem Pfad und Key laden und initialisieren. */
async function bootDb(dbPath, encryptionKey) {
  process.env.DB_PATH = dbPath;
  if (encryptionKey === null) {
    delete process.env.DB_ENCRYPTION_KEY;
  } else {
    process.env.DB_ENCRYPTION_KEY = encryptionKey;
  }
  const mod = await import(`../server/db.js?encryption=${++scenarioCounter}`);
  mod.init();
  return mod;
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'yuvomi-encryption-'));
}

/** true, wenn die Datei mit dem unverschlüsselten SQLite-Header beginnt. */
function isPlaintext(filePath) {
  const head = readFileSync(filePath).subarray(0, PLAINTEXT_HEADER.length);
  return head.equals(PLAINTEXT_HEADER);
}

/** Unverschlüsselte Bestands-Datenbank erzeugen, wie sie vor dem Fix entstand. */
function seedPlaintextDb(filePath, rows) {
  const seed = new Database(filePath);
  seed.pragma('journal_mode = WAL');
  seed.exec('CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY, note TEXT, payload BLOB)');
  const insert = seed.prepare('INSERT INTO legacy_marker (note, payload) VALUES (?, ?)');
  for (let i = 0; i < rows; i++) {
    insert.run(`Befund-${i} Müller/Ärztin`, Buffer.from([i % 256, 1, 2]));
  }
  seed.close();
}

test('das Binding bringt Cipher-Support mit', () => {
  const probe = new Database(':memory:');
  const { version } = probe.prepare('SELECT sqlite3mc_version() AS version').get();
  probe.close();
  assert.match(version, /Multiple Ciphers/, 'sqlite3mc_version() muss verfügbar sein');
});

test('ohne DB_ENCRYPTION_KEY bleibt die Datenbank unverschlüsselt (Entwicklung)', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  await bootDb(dbPath, null);

  assert.ok(existsSync(dbPath), 'Datenbank muss angelegt werden');
  assert.ok(isPlaintext(dbPath), 'ohne Key darf nicht verschlüsselt werden');
});

test('mit DB_ENCRYPTION_KEY ist eine frisch angelegte Datenbank wirklich verschlüsselt', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  await bootDb(dbPath, KEY);

  assert.ok(existsSync(dbPath), 'Datenbank muss angelegt werden');
  assert.ok(!isPlaintext(dbPath), 'Datei darf keinen Klartext-Header haben');

  // Ohne Key darf die Datei nicht zu öffnen sein.
  assert.throws(
    () => {
      const intruder = new Database(dbPath);
      intruder.prepare('SELECT count(*) FROM sqlite_master').get();
    },
    /file is not a database/,
    'ohne Key darf die Datenbank nicht lesbar sein'
  );
});

test('eine unverschlüsselte Bestands-Datenbank wird beim Start migriert', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  seedPlaintextDb(dbPath, 150);
  assert.ok(isPlaintext(dbPath), 'Vorbedingung: Bestands-DB ist unverschlüsselt');

  const mod = await bootDb(dbPath, KEY);

  assert.ok(!isPlaintext(dbPath), 'Datenbank muss nach dem Start verschlüsselt sein');

  // Daten müssen vollständig und unverändert sein.
  const { count } = mod.get().prepare('SELECT count(*) AS count FROM legacy_marker').get();
  assert.equal(count, 150, 'alle Zeilen müssen erhalten bleiben');
  const row = mod.get().prepare('SELECT note, payload FROM legacy_marker WHERE id = 42').get();
  assert.equal(row.note, 'Befund-41 Müller/Ärztin', 'Textinhalte inkl. Umlauten bleiben erhalten');
  assert.deepEqual([...row.payload], [41, 1, 2], 'BLOBs bleiben erhalten');
});

test('die Migration hinterlässt ein unverschlüsseltes Backup der Originaldatei', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  const backupPath = `${dbPath}.plaintext-backup`;
  seedPlaintextDb(dbPath, 10);

  await bootDb(dbPath, KEY);

  assert.ok(existsSync(backupPath), 'Backup der Originaldatei muss existieren');
  assert.ok(isPlaintext(backupPath), 'das Backup ist bewusst die unverschlüsselte Originaldatei');

  // Das Backup muss für sich lesbar sein, damit ein Rollback möglich bleibt.
  const backup = new Database(backupPath, { readonly: true });
  const { count } = backup.prepare('SELECT count(*) AS count FROM legacy_marker').get();
  backup.close();
  assert.equal(count, 10, 'das Backup muss den vollständigen Datenbestand enthalten');
});

test('eine unverschlüsselte Legacy-oikos.db wird im selben Start umbenannt und verschlüsselt', async () => {
  // Der kritische Bestandsfall: Legacy-Dateiname UND gesetzter Key. Würde die
  // Rename-Migration der noch unverschlüsselten oikos.db den Cipher-Key
  // aufsetzen, scheiterte ihr Checkpoint mit „file is not a database", der
  // Rename verschöbe sich auf den nächsten Boot und die Klartext-Sicherheits-
  // kopie hieße oikos.db.plaintext-backup — nicht der Name, den .env.example,
  // SECURITY.md und docs/installation.md zum Löschen nennen.
  const dir = tmpDir();
  const legacyPath = join(dir, 'oikos.db');
  const dbPath = join(dir, 'yuvomi.db');
  seedPlaintextDb(legacyPath, 20);

  const mod = await bootDb(legacyPath, KEY);

  assert.ok(existsSync(dbPath), 'die Datenbank muss im selben Start nach yuvomi.db umgezogen sein');
  assert.ok(!existsSync(legacyPath), 'die Legacy-Datei darf nicht liegenbleiben');
  assert.ok(!isPlaintext(dbPath), 'nach dem Umzug muss verschlüsselt sein');

  assert.ok(
    existsSync(`${dbPath}.plaintext-backup`),
    'die Sicherheitskopie muss unter dem dokumentierten Namen <DB_PATH>.plaintext-backup liegen'
  );
  assert.ok(
    !existsSync(`${legacyPath}.plaintext-backup`),
    'keine unverschlüsselte Kopie unter einem Namen, den die Doku nicht nennt'
  );

  const { count } = mod.get().prepare('SELECT count(*) AS count FROM legacy_marker').get();
  assert.equal(count, 20, 'alle Zeilen müssen den Umzug überstehen');
});

test('eine bereits verschlüsselte Datenbank wird beim nächsten Start nicht erneut migriert', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  const backupPath = `${dbPath}.plaintext-backup`;
  await bootDb(dbPath, KEY);
  assert.ok(!existsSync(backupPath), 'Neuinstallation braucht kein Migrations-Backup');

  // Zweiter Start auf derselben, bereits verschlüsselten Datei.
  const mod = await bootDb(dbPath, KEY);

  assert.ok(!isPlaintext(dbPath), 'Datenbank bleibt verschlüsselt');
  assert.ok(!existsSync(backupPath), 'ohne Klartext-Datei darf kein Backup entstehen');
  assert.doesNotThrow(
    () => mod.get().prepare('SELECT count(*) FROM sqlite_master').get(),
    'die Datenbank muss weiterhin nutzbar sein'
  );
});

test('ein falscher Key führt zu einem klaren Startfehler statt zu stillem Datenverlust', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  await bootDb(dbPath, KEY);

  await assert.rejects(
    () => bootDb(dbPath, 'ein-voellig-anderer-key'),
    /Wrong encryption key/,
    'falscher Key muss den Start abbrechen'
  );

  // Die Datei darf dabei unangetastet bleiben.
  assert.ok(!isPlaintext(dbPath), 'die Datenbank bleibt verschlüsselt');
});

test('ein blockierter WAL-Checkpoint bricht die Migration ab, statt Teildaten zu verschlüsseln', async () => {
  // wal_checkpoint(TRUNCATE) wirft nicht, wenn eine andere Verbindung liest —
  // es meldet busy != 0. Würde die Migration das ignorieren, verschlüsselte sie
  // eine unvollständige Kopie und löschte anschließend die WAL-Sidecars.
  const dbPath = join(tmpDir(), 'yuvomi.db');
  seedPlaintextDb(dbPath, 50);

  // Zweite Instanz auf demselben Volume: ein offener Writer hält das WAL
  // gefüllt, ein Reader mit laufender Transaktion blockiert den TRUNCATE.
  const writer = new Database(dbPath);
  writer.pragma('journal_mode = WAL');
  writer.prepare('INSERT INTO legacy_marker (note) VALUES (?)').run('im-wal');
  const reader = new Database(dbPath);
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM legacy_marker').get();

  try {
    await assert.rejects(
      () => bootDb(dbPath, KEY),
      /write-ahead log could not be checkpointed/,
      'die Migration muss bei blockiertem Checkpoint abbrechen'
    );

    // Entscheidend: die Datenbank muss unangetastet und vollständig bleiben.
    assert.ok(isPlaintext(dbPath), 'die Originaldatei bleibt unverändert');
  } finally {
    reader.exec('COMMIT');
    reader.close();
    writer.close();
  }

  const survivor = new Database(dbPath);
  const { count } = survivor.prepare('SELECT count(*) AS count FROM legacy_marker').get();
  survivor.close();
  assert.equal(count, 51, 'kein Datenverlust durch den abgebrochenen Versuch (50 + die WAL-Zeile)');
});

test('ein Backup der verschlüsselten Datenbank ist selbst verschlüsselt und wiederherstellbar', async () => {
  const dir = tmpDir();
  const dbPath = join(dir, 'yuvomi.db');
  const backupPath = join(dir, 'backup.db');
  const mod = await bootDb(dbPath, KEY);
  mod.get().exec('CREATE TABLE backup_marker (note TEXT)');
  mod.get().prepare('INSERT INTO backup_marker VALUES (?)').run('vor-backup');

  // Die SQLite-Backup-API scheitert an verschlüsselten Quellen ("incompatible
  // source and target databases"). Ohne den VACUUM-INTO-Zweig wäre bei gesetztem
  // Key jedes Backup kaputt — inklusive Scheduler und WebDAV-Upload.
  await mod.backupToFile(backupPath);

  assert.ok(existsSync(backupPath), 'Backup muss angelegt werden');
  assert.ok(!isPlaintext(backupPath), 'das Backup darf nicht im Klartext liegen');
  assert.ok(
    !readFileSync(backupPath).includes(Buffer.from('vor-backup')),
    'Inhalte dürfen im Backup nicht im Klartext auffindbar sein'
  );

  const restored = await mod.restoreFromFile(backupPath);
  assert.equal(restored.schemaVersion, mod.currentVersion(), 'Restore muss die Schema-Version melden');
  assert.equal(
    mod.get().prepare('SELECT note FROM backup_marker').get()?.note,
    'vor-backup',
    'Daten müssen den Restore überstehen'
  );
});

test('ein vor der Umstellung erzeugtes Klartext-Backup bleibt einspielbar', async () => {
  // Bestandsnutzer haben Backups aus der Zeit, in der DB_ENCRYPTION_KEY
  // wirkungslos war. Würde die Validierung ihnen den Key aufsetzen, wären diese
  // Backups nach dem Update wertlos.
  const legacyPath = join(tmpDir(), 'yuvomi.db');
  const legacy = await bootDb(legacyPath, null);
  legacy.get().exec('CREATE TABLE backup_marker (note TEXT)');
  legacy.get().prepare('INSERT INTO backup_marker VALUES (?)').run('altbestand');
  legacy.get().pragma('wal_checkpoint(TRUNCATE)');

  const dir = tmpDir();
  const oldBackup = join(dir, 'old-plaintext-backup.db');
  copyFileSync(legacyPath, oldBackup);
  assert.ok(isPlaintext(oldBackup), 'Vorbedingung: das alte Backup ist unverschlüsselt');

  const dbPath = join(dir, 'yuvomi.db');
  const mod = await bootDb(dbPath, KEY);

  const restored = await mod.restoreFromFile(oldBackup);
  assert.ok(restored.schemaVersion > 0, 'das alte Backup muss einspielbar sein');
  assert.equal(
    mod.get().prepare('SELECT note FROM backup_marker').get()?.note,
    'altbestand',
    'Daten aus dem alten Backup müssen ankommen'
  );
  assert.ok(!isPlaintext(dbPath), 'nach dem Restore muss wieder verschlüsselt sein');
});

test('ein Restore hinterlässt keine unverschlüsselte Kopie im Datenverzeichnis', async () => {
  // Ein eingespieltes Alt-Backup wird beim Restore verschlüsselt. Die Sicherung
  // dafür ist die Backup-Datei selbst plus `.pre-restore-*` — eine zusätzliche
  // Klartext-Vollkopie bliebe dauerhaft liegen und käme bei jedem weiteren
  // Restore erneut dazu, ohne dass die Backup-UI davon berichtet.
  const legacyPath = join(tmpDir(), 'yuvomi.db');
  const legacy = await bootDb(legacyPath, null);
  legacy.get().exec('CREATE TABLE restore_marker (note TEXT)');
  legacy.get().prepare('INSERT INTO restore_marker VALUES (?)').run('aus-dem-altbackup');
  legacy.get().pragma('wal_checkpoint(TRUNCATE)');

  const dir = tmpDir();
  const oldBackup = join(dir, 'altbestand.db');
  copyFileSync(legacyPath, oldBackup);
  assert.ok(isPlaintext(oldBackup), 'Vorbedingung: das alte Backup ist unverschlüsselt');

  const dbPath = join(dir, 'yuvomi.db');
  const mod = await bootDb(dbPath, KEY);

  await mod.restoreFromFile(oldBackup);
  await mod.restoreFromFile(oldBackup); // zweiter Lauf: nichts darf sich anhäufen

  const leftovers = readdirSync(dir).filter((name) => name.includes('plaintext-backup'));
  assert.deepEqual(leftovers, [], `keine Klartext-Kopien erwartet, gefunden: ${leftovers.join(', ')}`);

  assert.ok(!isPlaintext(dbPath), 'die wiederhergestellte Datenbank muss verschlüsselt sein');
  assert.equal(
    mod.get().prepare('SELECT note FROM restore_marker').get()?.note,
    'aus-dem-altbackup',
    'die Daten aus dem Backup müssen ankommen'
  );

  // Der Rollback-Anker bleibt: er ist verschlüsselt und deckt den Fehlerfall ab.
  assert.ok(
    readdirSync(dir).some((name) => name.includes('.pre-restore-')),
    'die pre-restore-Sicherung muss weiterhin entstehen'
  );
});

test('der SQLCipher-Cipher (AES-256) ist aktiv, nicht der Default ChaCha20', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  await bootDb(dbPath, KEY);

  const handle = new Database(dbPath);
  handle.pragma("cipher = 'sqlcipher'");
  handle.pragma(`key="x'${Buffer.from(KEY, 'utf8').toString('hex')}'"`);
  const readable = handle.prepare('SELECT count(*) AS count FROM sqlite_master').get();
  handle.close();

  assert.ok(readable.count >= 0, 'die Datenbank muss im sqlcipher-Modus lesbar sein');
});
