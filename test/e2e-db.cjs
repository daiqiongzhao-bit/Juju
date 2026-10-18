// E2E-Helfer: echte SQLCipher-DB erzeugen / ohne Schlüssel öffnen / mit Schlüssel prüfen.
// Nutzung: node e2e-db.cjs <create|open-no-key|check> <dbPath> <key>
// Der Schlüssel ist die rohe Zeichenkette (wie DB_ENCRYPTION_KEY in der
// Umwelt) — intern wird er hex-kodiert, EXACT wie server/db.js
// (applyEncryptionKey) es macht.
const Database = require('better-sqlite3-multiple-ciphers');

const [mode, dbPath, key] = process.argv.slice(2);

if (mode === 'create') {
  const db = new Database(dbPath);
  db.pragma("cipher = 'sqlcipher'");
  db.pragma(`key="x'${Buffer.from(key, 'utf8').toString('hex')}'"`);
  db.exec('CREATE TABLE t(x)');
  db.prepare('INSERT INTO t VALUES (?)').run('produktionsdaten');
  db.close();
  console.log('created encrypted db');
} else if (mode === 'open-no-key') {
  // Ohne key-Pragma: ein verschlüsselter File muss hier scheitern.
  try {
    const db = new Database(dbPath, { readonly: true });
    db.pragma('quick_check');
    db.close();
    console.log('OPENED_WITHOUT_KEY');
    process.exit(1);
  } catch {
    console.log('REFUSED_WITHOUT_KEY');
  }
} else if (mode === 'check') {
  const expected = process.argv[5] || null; // optional: erwarteter Wert in t(x)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("cipher = 'sqlcipher'");
  db.pragma(`key="x'${Buffer.from(key, 'utf8').toString('hex')}'"`);
  if (expected) {
    const row = db.prepare('SELECT x FROM t').get();
    db.close();
    if (!row || row.x !== expected) {
      console.error('WRONG_DATA');
      process.exit(1);
    }
  } else {
    // Fremde/echte DB: nur Beweisen, dass der Schlüssel passt.
    const r = db.prepare('SELECT count(*) c FROM sqlite_master').get();
    db.close();
    if (!r || r.c < 1) {
      console.error('EMPTY_DB');
      process.exit(1);
    }
  }
  console.log('DATA_INTACT');
} else {
  console.error('unknown mode');
  process.exit(2);
}
