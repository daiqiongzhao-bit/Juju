/**
 * Modul: Minimaler ZIP-Writer/-Reader
 * Zweck: Das Sicherungspaket soll ausser der Datenbank auch die Schlüsseldatei
 *        `/data/.juju-secrets` enthalten (ohne sie ist eine verschlüsselte DB
 *        nach einem Restore unlesbar). Dafür braucht es einen Container — und
 *        das Projekt bleibt bewusst ohne neue npm-Abhängigkeit.
 *
 * Umfang: nur das Nötige für diesen Anwendungsfall.
 *   - Schreiben: Store-Methode (kein Deflate), ein oder mehrere Einträge,
 *     Unix-Dateimodus in den externen Attributen (0600 für die Schlüsseldatei).
 *   - Lesen: zentrales Verzeichnis parsen, CRC32 prüfen, Namen validieren.
 *
 * Store statt Deflate ist hier keine Bequemlichkeit: die Datenbank ist mit
 * SQLCipher verschlüsselt und damit praktisch nicht komprimierbar — Deflate
 * kostete nur CPU und Speicher, ohne das Paket merklich zu verkleinern.
 *
 * Abhängigkeiten: keine
 */

/** Signatur eines lokalen Dateikopfs. */
const SIG_LOCAL = 0x04034b50;
/** Signatur eines Eintrags im zentralen Verzeichnis. */
const SIG_CENTRAL = 0x02014b50;
/** Signatur des End-of-Central-Directory. */
const SIG_EOCD = 0x06054b50;

/** Länge des lokalen Kopfs ohne Namens-/Extrafelder. */
const LOCAL_HEADER_BYTES = 30;
/** Länge eines Zentralverzeichnis-Eintrags ohne Namens-/Extra-/Kommentarfelder. */
const CENTRAL_HEADER_BYTES = 46;
/** Länge des EOCD ohne Kommentar. */
const EOCD_BYTES = 22;

/** Maximale Grösse eines Pakets beim Einlesen (Schutz vor Zip-Bombs). */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
/** Maximale Anzahl Einträge beim Einlesen. */
const MAX_ENTRIES = 64;

// --------------------------------------------------------
// CRC32
// --------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * CRC32 nach PKZIP (vorverkleinerte Tabelle).
 * @param {Buffer} buffer
 * @returns {number} unsigned 32-bit
 */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * DOS-Datum/-Zeit für die ZIP-Header (das Format kennt nur dieses).
 * @param {Date} [date]
 * @returns {{ time: number, date: number }}
 */
function dosDateTime(date = new Date()) {
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, date: day };
}

// --------------------------------------------------------
// Schreiben
// --------------------------------------------------------

/**
 * Baut ein ZIP-Archiv (Store-Methode).
 *
 * @param {{ name: string, data: Buffer, mode?: number }[]} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('[Zip] At least one entry is required.');
  }

  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(String(entry.name), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const checksum = crc32(data);
    // Standardmodus 0644; für Geheimnisse 0600 (siehe Aufrufer).
    const mode = Number.isInteger(entry.mode) ? entry.mode : 0o100644;

    const local = Buffer.alloc(LOCAL_HEADER_BYTES);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0, 6); // flags: keine
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18); // komprimiert
    local.writeUInt32LE(data.length, 22); // unkomprimiert
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, data);

    const central = Buffer.alloc(CENTRAL_HEADER_BYTES);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(0x031e, 4); // version made by: Unix, ZIP 3.0
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    // `>>> 0` ist Pflicht: der Unix-Modus mit Dateityp-Bits (0o100600) liegt
    // jenseits von 2^31 und würde als vorzeichenbehaftete Zahl negativ —
    // writeUInt32LE lehnt das ab.
    central.writeUInt32LE((mode << 16) >>> 0, 38); // external attrs: Unix-Modus
    central.writeUInt32LE(offset, 42); // Offset des lokalen Kopfs
    centrals.push(central, name);

    offset += LOCAL_HEADER_BYTES + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(EOCD_BYTES);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

// --------------------------------------------------------
// Lesen
// --------------------------------------------------------

/**
 * Prüft, ob ein Puffer ein ZIP-Archiv ist (lokale oder EOCD-Signatur).
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  return buffer.readUInt32LE(0) === SIG_LOCAL || buffer.readUInt32LE(0) === 0x06054b50;
}

/**
 * Liest ein (von createZip oder gängigen Tools geschriebenes) ZIP-Archiv.
 *
 * Sicherheitsregeln — ein Sicherungspaket kommt vom Nutzer und landet danach
 * auf der Platte, deshalb wird alles geprüft:
 *   - Namen dürfen keine Pfadtrenner, Laufwerksbuchstaben oder `..` enthalten
 *     (Zip-Slip);
 *   - CRC32 und Grössen müssen übereinstimmen (beschädigte/gefälschte Pakete
 *     fallen auf, bevor sie die Datenbank ersetzen);
 *   - Obergrenzen für Eintragszahl und Gesamtgrösse.
 *
 * @param {Buffer} buffer
 * @returns {{ name: string, data: Buffer }[]}
 * @throws {Error} bei beschädigtem oder regelwidrigem Archiv
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('[Zip] Input must be a buffer.');
  if (buffer.length > MAX_TOTAL_BYTES) throw new Error('[Zip] Archive is too large.');

  // EOCD von hinten suchen (Kommentare sind erlaubt, daher nicht am festen Ende).
  let eocdOffset = -1;
  for (let i = buffer.length - EOCD_BYTES; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('[Zip] Not a valid archive (no end-of-central-directory).');

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  if (entryCount === 0 || entryCount > MAX_ENTRIES) {
    throw new Error(`[Zip] Unsupported entry count: ${entryCount}.`);
  }
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('[Zip] Central directory is outside the archive.');
  }

  const result = [];
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + CENTRAL_HEADER_BYTES > buffer.length) throw new Error('[Zip] Truncated central directory.');
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) throw new Error('[Zip] Corrupt central directory.');

    const method = buffer.readUInt16LE(cursor + 10);
    if (method !== 0) throw new Error('[Zip] Only stored (uncompressed) entries are supported.');

    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const localOffset = buffer.readUInt32LE(cursor + 42);

    const name = buffer.toString('utf8', cursor + CENTRAL_HEADER_BYTES, cursor + CENTRAL_HEADER_BYTES + nameLength);
    assertSafeEntryName(name);
    if (compressedSize !== uncompressedSize) throw new Error(`[Zip] Entry "${name}" has inconsistent sizes.`);

    // Daten über den lokalen Kopf adressieren — nur der kennt die wahre
    // Länge von Name/Extra an dieser Stelle.
    if (localOffset + LOCAL_HEADER_BYTES > buffer.length) throw new Error(`[Zip] Entry "${name}" is outside the archive.`);
    if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`[Zip] Entry "${name}" has a corrupt local header.`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + LOCAL_HEADER_BYTES + localNameLength + localExtraLength;
    const dataEnd = dataStart + uncompressedSize;
    if (dataEnd > buffer.length) throw new Error(`[Zip] Entry "${name}" is truncated.`);

    const data = buffer.subarray(dataStart, dataEnd);
    if (crc32(data) !== expectedCrc) throw new Error(`[Zip] Entry "${name}" failed its checksum.`);

    result.push({ name, data: Buffer.from(data) });

    cursor += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
  }

  return result;
}

/**
 * Weist Dateinamen ab, die beim Entpacken aus dem Zielverzeichnis herausführen
 * würden (Zip-Slip) oder anderweitig unverwendbar sind.
 * @param {string} name
 * @throws {Error}
 */
function assertSafeEntryName(name) {
  if (!name) throw new Error('[Zip] Entry without a name.');
  if (name.length > 255) throw new Error('[Zip] Entry name is too long.');
  if (name.includes('\\') || name.includes('/')) throw new Error(`[Zip] Entry name must not contain path separators: ${name}`);
  if (name === '.' || name === '..') throw new Error(`[Zip] Illegal entry name: ${name}`);
  if (/^[A-Za-z]:/.test(name)) throw new Error(`[Zip] Entry name must not contain a drive letter: ${name}`);

  if (/[\u0000-\u001f]/.test(name)) throw new Error('[Zip] Entry name contains control characters.');
  if (name.startsWith('.')) {
    // Versteckte Dateien sind genau der Anwendungsfall (.juju-secrets) —
    // aber nur der eine, damit kein `.ssh/…`-artiger Name durchkommt.
    if (name !== '.juju-secrets') throw new Error(`[Zip] Unexpected hidden entry: ${name}`);
  }
}

export { assertSafeEntryName };
