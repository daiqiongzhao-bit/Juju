/**
 * Modul: Kontakt-Routen R3/R4 集成测试 (T04a - rnw 补差)
 * Zweck: 全链路验证 contacts.js 的加密/派生/可见性改造：
 *   1. POST 含 5 个新字段 + 生日自动换算（农历/生肖/星座）+ 敏感列加密落库；
 *   2. GET 列表 / ?phone=（phone_hash 精确命中）/ q（姓名；手机号按 PRD 无结果）；
 *   3. GET /:id 解密回显（含子表 value/value_e164/street）；
 *   4. vCard 导出必须是明文；
 *   5. PUT 不传 phone → 密文原样不动；PUT 传 phone → 新密文 + phone_hash 更新；
 *   6. 枚举校验（zodiac/constellation oneOf）与 priorityIntro 布尔校验；
 *   7. R4 ACL：非 admin 不见 hidden/ACL 屏蔽项（列表/单条/vCard 均 404），admin 全量；
 *      visibilityFilter/isVisible/visibleIdSet 单点（mock req）行为。
 * Ausführen: node --experimental-sqlite test/test-contacts-encryption.js
 * 加密副本模式: T04A_DB_PATH=/tmp/t04a.db node --experimental-sqlite test/test-contacts-encryption.js
 *   （断言均按本测试创建的 ID 收敛，两种模式下语义一致）
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

let passed = 0, failed = 0;
async function asyncTest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

console.log('\n[Contacts-Encryption-Test] R3/R4 HTTP-Schicht (T04a)\n');

// R3: SM4 应用层密钥（测试固定值；生产由 sm4-key-guard 拒启保护）。
process.env.JUJU_SM4_KEY = '0123456789abcdef0123456789abcdef';
// 可选：对 VACUUM INTO 制成的加密 v150 副本跑同一套断言。
const dbPath = process.env.T04A_DB_PATH || path.join(os.tmpdir(), `yuvomi-contacts-enc-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.SESSION_SECRET = 'contacts-encryption-test-secret-32bytes';

const db = await import('../server/db.js');
const { default: contactsRouter } = await import('../server/routes/contacts.js');
const { visibilityFilter, isVisible, visibleIdSet } = await import('../server/services/contact-visibility.js');
const { isCipher } = await import('../server/services/sm4.js');
const { deriveLunarFields } = await import('../server/services/lunar-fields.js');

db.init();
const database = db.get();

// region 决定 toE164 的默认国家（value_e164 派生）——与生产 sync_config 同名键。
database.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('region', 'zh-CN')").run();

// --------------------------------------------------------
// Fixtures: 两个用户（admin + member）。副本模式下 user 1 已存在（admin）。
// --------------------------------------------------------
if (!database.prepare('SELECT id FROM users WHERE id = 1').get()) {
  database.prepare(
    "INSERT INTO users (username, display_name, password_hash, avatar_color, role) VALUES ('enc-admin', 'Admin', 'x', '#007AFF', 'admin')"
  ).run();
}
let memberUserId = database.prepare("SELECT id FROM users WHERE username = 'enc-member'").get()?.id;
if (!memberUserId) {
  memberUserId = database.prepare(
    "INSERT INTO users (username, display_name, password_hash, avatar_color, role) VALUES ('enc-member', 'Member', 'x', '#34C759', 'member')"
  ).run().lastInsertRowid;
}

function mkApp(userId, role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.authRole = role;
    req.session = { userId, role };
    next();
  });
  app.use('/contacts', contactsRouter);
  return app;
}

const adminApp = mkApp(1, 'admin');
const memberApp = mkApp(memberUserId, 'member');

// Hinweis: die Server werden sequenziell gestartet (await zwischen den listen-
// Aufrufen) — zwei listen()-Aufgaben im selben Tick lassen das 'listening'-
// Event des zweiten Servers auf Node 24 nicht feuern.
const adminServer = adminApp.listen(0, '127.0.0.1');
await new Promise((r) => adminServer.once('listening', r));
const memberServer = memberApp.listen(0, '127.0.0.1');
await new Promise((r) => memberServer.once('listening', r));
const adminBase = `http://127.0.0.1:${adminServer.address().port}/contacts`;
const memberBase = `http://127.0.0.1:${memberServer.address().port}/contacts`;

const jget = async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => null) }; };
const jsend = async (u, method, body) => {
  const r = await fetch(u, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const tget = async (u) => {
  const r = await fetch(u);
  return { status: r.status, text: await r.text(), contentType: r.headers.get('content-type') };
};

try {
  // ------------------------------------------------------------------
  // 1. POST: 5 新字段 + 生日自动换算 + 加密列
  // ------------------------------------------------------------------
  const derived = deriveLunarFields('1990-07-18');
  let contactId;
  await asyncTest('POST / legt Kontakt mit 5 neuen Feldern, auto-Lunar und Verschlüsselung an', async () => {
    const { status, body } = await jsend(adminBase, 'POST', {
      name: '加密测试员',
      category: 'misc',
      phone: '13800138000',
      email: 'enc@example.com',
      address: '北京市朝阳区测试路1号',
      vehiclePlate: '京A12345',
      birthday: '1990-07-18',
      spouseNote: '配偶备注文本',
      priorityIntro: true,
      phones: [{ label: 'Mobil', value: '13900139000', isPrimary: true }],
      addresses: [{ label: 'Zuhause', street: '上海市浦东新区测试路2号', city: '上海', postalCode: '200120', country: 'CN', isPrimary: true }],
    });
    assert(status === 201, `Status ${status}`);
    const d = body.data;
    contactId = d.id;
    // 响应解密回显（明文）。
    assert(d.phone === '13800138000', `phone entschlüsselt, war ${d.phone}`);
    assert(d.address === '北京市朝阳区测试路1号', 'address entschlüsselt');
    assert(d.vehicle_plate === '京A12345' && d.vehiclePlate === '京A12345', 'vehiclePlate entschlüsselt (beide Aliasse)');
    assert(d.phones[0].value === '13900139000', 'phones.value entschlüsselt');
    assert(d.phones[0].valueE164 && d.phones[0].valueE164.startsWith('+'), `valueE164 entschlüsselt: ${d.phones[0].valueE164}`);
    assert(d.addresses[0].street === '上海市浦东新区测试路2号', 'street entschlüsselt');
    // 生日自动换算（T02 单一数据源）。
    assert(d.birthday === '1990-07-18', 'birthday gespeichert');
    assert(d.birthdayLunar === derived.birthdayLunar, `birthdayLunar auto: ${d.birthdayLunar} = ${derived.birthdayLunar}`);
    assert(d.zodiac === derived.zodiac, `zodiac auto: ${d.zodiac} = ${derived.zodiac}`);
    assert(d.constellation === derived.constellation, `constellation auto: ${d.constellation} = ${derived.constellation}`);
    assert(d.spouseNote === '配偶备注文本', 'spouseNote gespeichert');
    assert(d.priorityIntro === true, 'priorityIntro boolean true');
    // phone_hash 绝不进响应。
    assert(d.phone_hash === undefined, 'phone_hash nicht im Response-Body');
    // DB 层：密文 + 指纹。
    const row = database.prepare('SELECT phone, phone_hash, address, vehicle_plate FROM contacts WHERE id = ?').get(contactId);
    assert(isCipher(row.phone), 'contacts.phone ist Chiffrat (v1.)');
    assert(row.phone_hash && /^[0-9a-f]{64}$/.test(row.phone_hash), 'phone_hash = 64 hex');
    assert(isCipher(row.address) && isCipher(row.vehicle_plate), 'address/vehicle_plate chiffriert');
    const cp = database.prepare('SELECT value, value_e164 FROM contact_phones WHERE contact_id = ?').get(contactId);
    assert(isCipher(cp.value) && isCipher(cp.value_e164), 'contact_phones value/value_e164 chiffriert');
    const ca = database.prepare('SELECT street FROM contact_addresses WHERE contact_id = ?').get(contactId);
    assert(isCipher(ca.street), 'contact_addresses.street chiffriert');
  });

  // ------------------------------------------------------------------
  // 2. GET / 列表 + ?phone= 精确命中 + q（姓名/手机号）
  // ------------------------------------------------------------------
  await asyncTest('GET / entschlüsselt; ?phone= trifft phone_hash; q trifft Name, nicht phone', async () => {
    const all = await jget(adminBase);
    const row = all.body.data.find((c) => c.id === contactId);
    assert(row && row.phone === '13800138000', 'Liste entschlüsselt phone');

    const byPhone = await jget(`${adminBase}?phone=13800138000`);
    assert(byPhone.body.data.some((c) => c.id === contactId), '?phone= exakter Treffer (phone_hash)');

    const byPhoneWrong = await jget(`${adminBase}?phone=13800138001`);
    assert(!byPhoneWrong.body.data.some((c) => c.id === contactId), '?phone= Falschwert → kein Treffer');

    const byName = await jget(`${adminBase}?q=${encodeURIComponent('加密测试员')}`);
    assert(byName.body.data.some((c) => c.id === contactId), 'q trifft Name');

    // PRD-erwartet: q 搜手机号无结果（密文不可 LIKE）。
    const byPhoneLegacy = await jget(`${adminBase}?q=13800138000`);
    assert(!byPhoneLegacy.body.data.some((c) => c.id === contactId), 'q 搜手机号无 Treffer (PRD-erwartet)');
  });

  // ------------------------------------------------------------------
  // 3. GET /:id 解密回显
  // ------------------------------------------------------------------
  await asyncTest('GET /:id liefert entschlüsselte Skalar- und Multi-Value-Felder', async () => {
    const { status, body } = await jget(`${adminBase}/${contactId}`);
    assert(status === 200, `Status ${status}`);
    assert(body.data.phone === '13800138000', 'phone entschlüsselt');
    assert(body.data.phones[0].value === '13900139000' && body.data.phones[0].valueE164.startsWith('+'), 'Sub-Tabelle entschlüsselt');
    assert(body.data.addresses[0].street === '上海市浦东新区测试路2号', 'street entschlüsselt');
    assert(body.data.phone_hash === undefined, 'phone_hash nicht ausgeliefert');
  });

  // ------------------------------------------------------------------
  // 4. vCard 导出明文
  // ------------------------------------------------------------------
  await asyncTest('GET /:id/vcard exportiert Klartext (TEL/ADR)', async () => {
    const { status, text } = await tget(`${adminBase}/${contactId}/vcard`);
    assert(status === 200, `Status ${status}`);
    assert(text.includes('TEL;TYPE=VOICE:13800138000'), 'TEL im Klartext');
    assert(text.includes('北京市朝阳区测试路1号'), 'ADR (Skalarspalte) im Klartext');
    assert(!text.includes('v1.'), 'keine Chiffrat-Fragmente im Export');
  });

  // ------------------------------------------------------------------
  // 5. PUT 不传 phone → 密文原样；PUT 传 phone → 新密文 + 新指纹
  // ------------------------------------------------------------------
  await asyncTest('PUT /:id ohne phone lässt Chiffrat + phone_hash byte-gleich', async () => {
    const before = database.prepare('SELECT phone, phone_hash FROM contacts WHERE id = ?').get(contactId);
    const { status, body } = await jsend(`${adminBase}/${contactId}`, 'PUT', { notes: 'nur Notiz' });
    assert(status === 200, `Status ${status}`);
    assert(body.data.phone === '13800138000', 'Response weiterhin entschlüsselt');
    const after = database.prepare('SELECT phone, phone_hash FROM contacts WHERE id = ?').get(contactId);
    assert(after.phone === before.phone, 'Chiffrat byte-gleich (kein Re-Encrypt)');
    assert(after.phone_hash === before.phone_hash, 'phone_hash unverändert');
  });

  await asyncTest('PUT /:id mit phone → neues Chiffrat + aktualisierter phone_hash', async () => {
    const before = database.prepare('SELECT phone, phone_hash FROM contacts WHERE id = ?').get(contactId);
    const { status, body } = await jsend(`${adminBase}/${contactId}`, 'PUT', { phone: '13700137000' });
    assert(status === 200, `Status ${status}`);
    assert(body.data.phone === '13700137000', 'neuer phone entschlüsselt');
    const after = database.prepare('SELECT phone, phone_hash FROM contacts WHERE id = ?').get(contactId);
    assert(isCipher(after.phone) && after.phone !== before.phone, 'neues Chiffrat (neuer IV)');
    assert(after.phone_hash !== before.phone_hash, 'phone_hash aktualisiert');
    // 新手机号精确检索命中。
    const byPhone = await jget(`${adminBase}?phone=13700137000`);
    assert(byPhone.body.data.some((c) => c.id === contactId), 'neue Nummer via ?phone= treffbar');
    const byOld = await jget(`${adminBase}?phone=13800138000`);
    assert(!byOld.body.data.some((c) => c.id === contactId), 'alte Nummer nicht mehr treffbar');
  });

  // ------------------------------------------------------------------
  // 6. 枚举/布尔校验
  // ------------------------------------------------------------------
  await asyncTest('POST /: ungültige Enum-Werte → 400; gültige → 201 (explizit schlägt Auto)', async () => {
    const badZodiac = await jsend(adminBase, 'POST', { name: 'Bad Zodiac', zodiac: 'Dragon' });
    assert(badZodiac.status === 400, `zodiac 'Dragon' → 400, war ${badZodiac.status}`);
    assert(/Zodiac/.test(badZodiac.body.error), 'Fehlermeldung nennt Zodiac');

    const badConst = await jsend(adminBase, 'POST', { name: 'Bad Const', constellation: 'Aries' });
    assert(badConst.status === 400, `constellation 'Aries' → 400, war ${badConst.status}`);

    const badPrio = await jsend(adminBase, 'POST', { name: 'Bad Prio', priorityIntro: 'ja' });
    assert(badPrio.status === 400, `priorityIntro 'ja' → 400, war ${badPrio.status}`);

    // '龙' 是 T02 枚举的合法值（任务书示例与其标注不符——见 DEV_LOG T04a）；
    // 合法枚举 + 生日自动换算的显式覆盖：1990-07-18 派生为「马」，显式传「龙」以请求为准。
    const ok = await jsend(adminBase, 'POST', { name: 'Enum OK', birthday: '1990-07-18', zodiac: '龙' });
    assert(ok.status === 201, `zodiac '龙' (gültig) → 201, war ${ok.status}`);
    assert(ok.body.data.zodiac === '龙', 'expliziter Zodiac hat Vorrang vor Auto-Ableitung');
    assert(ok.body.data.constellation === derived.constellation, 'nicht gesetzte Derived folgen der Auto-Ableitung');
  });

  await asyncTest('PUT /:id: ungültige Enum-Werte → 400', async () => {
    const { status } = await jsend(`${adminBase}/${contactId}`, 'PUT', { constellation: 'Unicorn' });
    assert(status === 400, `constellation 'Unicorn' → 400, war ${status}`);
  });

  // ------------------------------------------------------------------
  // 7. R4 ACL：非 admin 不见 hidden/ACL 屏蔽项
  // ------------------------------------------------------------------
  let hiddenId;
  let aclId;
  await asyncTest('Fixture: hidden-Kontakt + ACL-Kontakt', async () => {
    const h = await jsend(adminBase, 'POST', { name: '隐藏联系人', phone: '13600136000' });
    hiddenId = h.body.data.id;
    database.prepare('UPDATE contacts SET hidden = 1 WHERE id = ?').run(hiddenId);
    const a = await jsend(adminBase, 'POST', { name: 'ACL联系人', phone: '13500135000' });
    aclId = a.body.data.id;
    database.prepare('INSERT INTO contact_node_acl (contact_id, user_id) VALUES (?, ?)').run(aclId, memberUserId);
  });

  await asyncTest('R4: member sieht weder hidden noch ACL-Kontakt (Liste + Einzel + vCard → 404)', async () => {
    const list = await jget(memberBase);
    assert(!list.body.data.some((c) => c.id === hiddenId), 'hidden nicht in member-Liste');
    assert(!list.body.data.some((c) => c.id === aclId), 'ACL nicht in member-Liste');
    assert(list.body.data.some((c) => c.id === contactId), 'normaler Kontakt für member sichtbar');

    const hiddenGet = await jget(`${memberBase}/${hiddenId}`);
    assert(hiddenGet.status === 404, `hidden via member → 404, war ${hiddenGet.status}`);
    const aclGet = await jget(`${memberBase}/${aclId}`);
    assert(aclGet.status === 404, `ACL via member → 404, war ${aclGet.status}`);
    const vc = await tget(`${memberBase}/${hiddenId}/vcard`);
    assert(vc.status === 404, `hidden vCard via member → 404, war ${vc.status}`);
  });

  await asyncTest('R4: admin sieht hidden + ACL-Kontakt (全量)', async () => {
    const list = await jget(adminBase);
    assert(list.body.data.some((c) => c.id === hiddenId), 'hidden in admin-Liste');
    assert(list.body.data.some((c) => c.id === aclId), 'ACL in admin-Liste');
    const hiddenGet = await jget(`${adminBase}/${hiddenId}`);
    assert(hiddenGet.status === 200, `hidden via admin → 200, war ${hiddenGet.status}`);
  });

  await asyncTest('R4: visibilityFilter/isVisible/visibleIdSet (mock req)', () => {
    // admin → 无过滤片段。
    assert(visibilityFilter({ authRole: 'admin', authUserId: 1 }, 'contacts').sql === '', 'admin: leeres SQL');
    // 非 admin → ACL 子查询。
    const f = visibilityFilter({ authRole: 'member', authUserId: memberUserId }, 'c');
    assert(f.sql.includes('c.hidden = 0') && f.sql.includes('contact_node_acl') && f.params[0] === memberUserId, 'member: ACL-Fragment');
    // 匿名 → fail-closed。
    assert(visibilityFilter({}, 'contacts').sql === ' AND 1=0', 'anonym: AND 1=0');
    // session-Fallback（无 authRole/authUserId）。
    const s = visibilityFilter({ session: { userId: memberUserId, role: 'member' } }, 'contacts');
    assert(s.params[0] === memberUserId, 'session-Fallback für uid');
    assert(visibilityFilter({ session: { role: 'admin' } }, 'contacts').sql === '', 'session-Fallback für admin');

    // JS 侧单点判定。
    assert(isVisible({ authRole: 'admin', authUserId: 1 }, hiddenId) === true, 'admin sieht hidden');
    assert(isVisible({ authRole: 'member', authUserId: memberUserId }, hiddenId) === false, 'member sieht hidden nicht');
    assert(isVisible({ authRole: 'member', authUserId: memberUserId }, aclId) === false, 'member sieht ACL nicht');
    assert(isVisible({ authRole: 'member', authUserId: memberUserId }, contactId) === true, 'member sieht normalen');
    assert(isVisible({ authRole: 'member', authUserId: memberUserId }, 999999) === false, 'unbekannte ID → false');
    assert(isVisible({}, contactId) === false, 'anonym → false');

    // 批量集合。
    assert(visibleIdSet({ authRole: 'admin' }) === null, 'admin → null (无限制)');
    const set = visibleIdSet({ authRole: 'member', authUserId: memberUserId });
    assert(set instanceof Set && set.has(contactId) && !set.has(hiddenId) && !set.has(aclId), 'member-Set ohne hidden/ACL');
  });

  // ------------------------------------------------------------------
  // 8. 派生字段 PUT 语义：不动生日 → 派生不动；改生日 → 重算；显式 → 优先
  // ------------------------------------------------------------------
  await asyncTest('PUT /:id Lunar-Semantik: unberührt / neu berechnet / explizit', async () => {
    // 不动生日：派生字段保持。
    const keep = await jsend(`${adminBase}/${contactId}`, 'PUT', { notes: 'nur notiz2' });
    assert(keep.body.data.zodiac === derived.zodiac, 'ohne birthday: zodiac unberührt');

    // 改生日：重算。
    const changed = await jsend(`${adminBase}/${contactId}`, 'PUT', { birthday: '2000-01-01' });
    const d2000 = deriveLunarFields('2000-01-01');
    assert(changed.body.data.birthdayLunar === d2000.birthdayLunar, 'neue birthday automatisch neu abgeleitet');
    assert(changed.body.data.zodiac === d2000.zodiac, 'zodiac neu berechnet');

    // 清空生日：派生字段置 NULL。
    const cleared = await jsend(`${adminBase}/${contactId}`, 'PUT', { birthday: '' });
    assert(cleared.body.data.birthday === null && cleared.body.data.zodiac === null && cleared.body.data.constellation === null,
      'birthday geleert → Derived NULL');

    // 显式修正无需生日。
    const explicit = await jsend(`${adminBase}/${contactId}`, 'PUT', { zodiac: '虎' });
    assert(explicit.body.data.zodiac === '虎', 'expliziter zodiac ohne birthday');
    // 恢复生日，供后续断言稳定。
    await jsend(`${adminBase}/${contactId}`, 'PUT', { birthday: '1990-07-18' });
  });

  // ------------------------------------------------------------------
  // 9. GET /meta 下发枚举
  // ------------------------------------------------------------------
  await asyncTest('GET /meta liefert zodiacs + constellations (12 值)', async () => {
    const { body } = await jget(`${adminBase}/meta`);
    assert(Array.isArray(body.data.zodiacs) && body.data.zodiacs.length === 12, '12 Zodiacs');
    assert(Array.isArray(body.data.constellations) && body.data.constellations.length === 12, '12 Constellations');
    assert(body.data.zodiacs.includes('龙'), '龙 ist gültiger Enum-Wert');
  });

  // ------------------------------------------------------------------
  // 10. 全局搜索（search.js）：姓名可搜，手机号不可搜（FTS 手机号为密文）
  // ------------------------------------------------------------------
  await asyncTest('Suche: name trifft, phone nicht (FTS-Body enthält Chiffrat)', async () => {
    const { runSearch } = await import('../server/services/search.js');
    const byName = runSearch(database, '加密测试员', 1, true);
    assert(byName.contacts.some((c) => c.id === contactId), 'FTS trifft Kontakt-Namen');
    const byPhone = runSearch(database, '13800138000', 1, true);
    assert(!byPhone.contacts.some((c) => c.id === contactId), 'FTS trifft phone nicht (PRD-erwartet)');
  });
} finally {
  adminServer.close();
  memberServer.close();
  if (!process.env.T04A_DB_PATH) {
    try { fs.unlinkSync(dbPath); } catch { /* egal */ }
    try { fs.unlinkSync(`${dbPath}-wal`); } catch { /* egal */ }
    try { fs.unlinkSync(`${dbPath}-shm`); } catch { /* egal */ }
  }
}

console.log(`\n[Contacts-Encryption-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed > 0 ? 1 : 0);
