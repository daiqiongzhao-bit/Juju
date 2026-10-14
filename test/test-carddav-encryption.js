/**
 * Modul: CardDAV R3 往返测试 (T04a - rnw 补差)
 * Zweck: 单测级验证 cardav-sync.js 三处（+两处标量写入）改造路径：
 *   - 插入（insertContactMultiValues + Step-3-INSERT）：value/value_e164/street
 *     及 contacts.phone/address 加密落库，phone_hash 同步；
 *   - 匹配（findContactByEmailOrPhone）：解密后 JS 侧匹配——value_e164 优先、
 *     value 精确回落、contacts.phone_hash 等值；格式变体仍然归并（kein Duplikat）；
 *   - 更新（updateContactMultiValues/updateContact）：解密读出不重复插入；
 *     采纳路径（fillAll）写密文而非明文。
 * Ausführen: node --experimental-sqlite test/test-carddav-encryption.js
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';

// R3: SM4 应用层密钥（测试固定值；生产由 sm4-key-guard 拒启保护）。
process.env.JUJU_SM4_KEY = '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = path.join(os.tmpdir(), `yuvomi-carddav-enc-${process.pid}.db`);
process.env.SESSION_SECRET = 'carddav-encryption-test-secret-32bytes';

const db = await import('../server/db.js');
const { parseAndMergeContact } = await import('../server/services/cardav-sync.js');
const { decryptField, isCipher, phoneHash } = await import('../server/services/sm4.js');

db.init();
const database = db.get();

const AB = 'https://d.example/dav/ab/';

function account() {
  return database.prepare(
    "INSERT INTO carddav_accounts (name, carddav_url, username, password) VALUES ('acc', 'https://d.example/dav/', 'u', 'p')"
  ).run().lastInsertRowid;
}

const vcard = (uid, tel, street = 'Teststrasse 1') =>
  `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:Max Muster\r\nN:Muster;Max;;;\r\n` +
  `TEL;TYPE=CELL:${tel}\r\nADR;TYPE=HOME:;;${street};Berlin;10115;DE\r\nEND:VCARD`;

describe('CardDAV R3 往返 (T04a)', () => {
  let accId;
  before(() => {
    // region → toE164-Defaultland (wie Produktiv-Sync); nationale Nummern werden
    // nur so zu value_e164 normalisiert.
    database.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('region', 'de-DE')").run();
    accId = account();
  });

  it('插入：value/value_e164/street 与 Skalar-phone/address  verschlüsselt, phone_hash gesetzt', async () => {
    const id = await parseAndMergeContact(vcard('uid-enc-1', '+49 30 12345678'), accId, AB);
    const c = database.prepare('SELECT phone, phone_hash, address FROM contacts WHERE id = ?').get(id);
    assert.ok(isCipher(c.phone), 'contacts.phone chiffriert');
    assert.equal(decryptField(c.phone), '+49 30 12345678', 'contacts.phone entschlüsselt = Rohwert');
    assert.equal(c.phone_hash, phoneHash('+49 30 12345678'), 'phone_hash = HMAC(Rohwert)');
    assert.ok(isCipher(c.address), 'contacts.address chiffriert');

    const p = database.prepare('SELECT value, value_e164 FROM contact_phones WHERE contact_id = ?').get(id);
    assert.ok(isCipher(p.value) && isCipher(p.value_e164), 'phones value/value_e164 chiffriert');
    assert.equal(decryptField(p.value), '+49 30 12345678', 'value entschlüsselt');
    assert.equal(decryptField(p.value_e164), '+493012345678', 'value_e164 entschlüsselt (toE164 vor Verschlüsselung)');

    const a = database.prepare('SELECT street, city FROM contact_addresses WHERE contact_id = ?').get(id);
    assert.ok(isCipher(a.street), 'street chiffriert');
    assert.equal(decryptField(a.street), 'Teststrasse 1', 'street entschlüsselt');
    assert.equal(a.city, 'Berlin', 'city bleibt Klartext');
  });

  it('匹配：Format-Variante derselben Nummer verschmilzt (value_e164 vor value)', async () => {
    // Gleiche Nummer, nationale Schreibweise, andere UID → kein Zweitkontakt.
    const id2 = await parseAndMergeContact(vcard('uid-enc-2', '030 12345678'), accId, AB);
    const n = database.prepare('SELECT COUNT(*) AS n FROM contacts WHERE carddav_account_id = ?').get(accId).n;
    assert.equal(n, 1, 'Format-Varianz erzeugt kein Duplikat');
    const p = database.prepare('SELECT value, value_e164 FROM contact_phones WHERE contact_id = ?').get(id2);
    assert.equal(decryptField(p.value), '+49 30 12345678', 'bestehender (erster) Wert unverändert');
  });

  it('匹配：exakter Rohwert-Fallback ohne value_e164 (unparsebar)', async () => {
    const idA = await parseAndMergeContact(vcard('uid-raw-1', 'Durchwahl-42'), accId, AB);
    const idB = await parseAndMergeContact(vcard('uid-raw-2', 'Durchwahl-42'), accId, AB);
    assert.equal(idA, idB, 'exakter Rohwert-Match verhindert Duplikat');
    const p = database.prepare('SELECT value, value_e164 FROM contact_phones WHERE contact_id = ?').get(idA);
    assert.equal(p.value_e164, null, 'unparsebar → value_e164 NULL');
  });

  it('更新：Re-Sync derselben vCard ist idempotent (entschlüsselter Vergleich)', async () => {
    // Dedizierter Kontakt: zweimal dieselbe vCard → kein zweiter Telefon-/Adress-Eintrag.
    // (Semantik wie vor R3: der Nicht-Primär-Bestand wird auf exactly die Einträge
    // dieser vCard gesetzt; unveränderte Wiedersync → sameSet → kein Schreiben.)
    const id = await parseAndMergeContact(vcard('uid-idem-1', '+49 30 555555'), accId, AB);
    const phonesBefore = database.prepare('SELECT COUNT(*) AS n FROM contact_phones WHERE contact_id = ?').get(id).n;
    const addrBefore = database.prepare('SELECT COUNT(*) AS n FROM contact_addresses WHERE contact_id = ?').get(id).n;
    await parseAndMergeContact(vcard('uid-idem-1', '+49 30 555555'), accId, AB);
    const phonesAfter = database.prepare('SELECT COUNT(*) AS n FROM contact_phones WHERE contact_id = ?').get(id).n;
    const addrAfter = database.prepare('SELECT COUNT(*) AS n FROM contact_addresses WHERE contact_id = ?').get(id).n;
    assert.equal(phonesBefore, 1, 'ein Telefon nach Erstsynchronisation');
    assert.equal(phonesAfter, phonesBefore, 'Re-Sync fügt kein Telefon doppelt ein');
    assert.equal(addrAfter, addrBefore, 'Re-Sync fügt keine Adresse doppelt ein');
  });

  it('采纳（fillAll）：lokaler Kontakt bekommt phone/address als Chiffrat + phone_hash', async () => {
    const localId = database.prepare(
      "INSERT INTO contacts (name, category, email) VALUES ('Lokaler Kontakt', 'misc', 'adopt@example.com')"
    ).run().lastInsertRowid;
    const adopted = await parseAndMergeContact(
      `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:uid-adopt-1\r\nFN:Lokaler Kontakt\r\nN:Kontakt;Lokaler;;;\r\n` +
      `EMAIL:adopt@example.com\r\nTEL;TYPE=CELL:+49 30 999999\r\nEND:VCARD`,
      accId, AB
    );
    assert.equal(adopted, localId, 'E-Mail-Match adoptiert den lokalen Kontakt');
    const c = database.prepare('SELECT phone, phone_hash FROM contacts WHERE id = ?').get(localId);
    assert.ok(isCipher(c.phone), 'Adoption schreibt Chiffrat (nicht Klartext)');
    assert.equal(decryptField(c.phone), '+49 30 999999', 'adoptierter phone entschlüsselt');
    assert.equal(c.phone_hash, phoneHash('+49 30 999999'), 'phone_hash der Adoption gesetzt');
  });
});

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${process.env.DB_PATH}${suffix}`); } catch { /* egal */ }
  }
});
