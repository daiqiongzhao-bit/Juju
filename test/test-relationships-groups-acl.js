/**
 * Modul: Relationships-Routen R3/R4 集成测试 (T04b - rnw 补差)
 * Zweck: 全链路验证 relationships.js 的改造：
 *   1. GET /meta/options 增补 zodiacs/constellations（各 12 值，单一数据源）；
 *   2. PATCH /contacts/:id：5 个新字段（含生日自动换算农历/生肖/星座、显式修正优先）、
 *      zodiac 非法值 400、priorityIntro 布尔校验、vehiclePlate 加密落库 + 响应解密回显、
 *      phone_hash 不出现在响应中、logOp 落审计；
 *   3. 分组 7 端点全流程：建两个组 → 重名（COLLATE NOCASE）409 → 改名/改色/排序 →
 *      groupId 绑定 + name 自动建组绑定 → 联系人分组列表 → 解绑 → DELETE 组后 map 级联清；
 *   4. ACL：非 admin 调 4 端点全 403；admin 建规则后被屏蔽用户在 edges/graph/common/
 *      reminders/insights/interactions/anniversaries/preferences/tags 均不可见（404 语义），
 *      admin 视野不变；DELETE 规则后恢复；GET /acl?contactId= 按联系人过滤
 *      （全量 / 有规则 1 条 / 无规则空列 / 非法值 400，BUG-1 回归）；
 *   5. tree-export 按可见性过滤（无密文列，无需解密）；
 *   6. fail-closed：无 uid 的请求 visibilityFilter → AND 1=0（mock req + HTTP 双测）；
 *   7. contact-visibility.js 服务函数单点（mock req）行为。
 * Ausführen: node --experimental-sqlite test/test-relationships-groups-acl.js
 * 加密副本模式: T04B_DB_PATH=/tmp/t04b.db node --experimental-sqlite test/test-relationships-groups-acl.js
 *   （断言均按本测试创建的 ID 收敛，两种模式下语义一致）
 */

import os from 'node:os';
import path from 'node:path';
import express from 'express';

let passed = 0, failed = 0;
async function asyncTest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

console.log('\n[Relationships-Groups-ACL-Test] R3/R4 HTTP-Schicht (T04b)\n');

// R3: SM4 应用层密钥（测试固定值；生产由 sm4-key-guard 拒启保护）。
process.env.JUJU_SM4_KEY = '0123456789abcdef0123456789abcdef';
// 可选：对 VACUUM INTO 制成的加密 v150 副本跑同一套断言。
const dbPath = process.env.T04B_DB_PATH || path.join(os.tmpdir(), `yuvomi-rel-groups-acl-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.SESSION_SECRET = 'relationships-groups-acl-test-secret-32';

const db = await import('../server/db.js');
const { default: relationshipsRouter } = await import('../server/routes/relationships.js');
const { visibilityFilter, isVisible, visibleIdSet } = await import('../server/services/contact-visibility.js');
const { isCipher, decryptField } = await import('../server/services/sm4.js');

db.init();
const database = db.get();

// --------------------------------------------------------
// Fixtures: 两个用户（admin + member）。副本模式下 user 1 已存在（admin）。
// --------------------------------------------------------
if (!database.prepare('SELECT id FROM users WHERE id = 1').get()) {
  database.prepare(
    "INSERT INTO users (username, display_name, password_hash, avatar_color, role) VALUES ('rel-admin', 'Admin', 'x', '#007AFF', 'admin')"
  ).run();
}
const adminId = database.prepare('SELECT id FROM users WHERE id = 1').get().id;
let memberUserId = database.prepare("SELECT id FROM users WHERE username = 'rel-member'").get()?.id;
if (!memberUserId) {
  memberUserId = database.prepare(
    "INSERT INTO users (username, display_name, password_hash, avatar_color, role) VALUES ('rel-member', 'Member', 'x', '#34C759', 'member')"
  ).run().lastInsertRowid;
}

// --------------------------------------------------------
// Fixtures: 联系人（含 hidden）+ 边 + 互动/纪念日/生日 + 偏好。
// 名称带测试专属前缀，断言按 ID 收敛（副本模式下存量数据不干扰）。
// --------------------------------------------------------
const TAG = `t04b-${process.pid}-`;
const insertContact = (name, extra = {}) => database.prepare(
  `INSERT INTO contacts (name, birthday, hidden) VALUES (?, ?, ?)`
).run(`${TAG}${name}`, extra.birthday ?? null, extra.hidden ? 1 : 0).lastInsertRowid;

const c1 = insertContact('Alpha', { birthday: '1990-05-20' });
const c2 = insertContact('Bravo');
const c3 = insertContact('Charlie', { birthday: '1988-03-15' });
const cHidden = insertContact('Ghost', { hidden: true });

const insertEdge = (a, b) => database.prepare(
  'INSERT INTO contact_relationships (contact_a, contact_b, relation_type, created_by) VALUES (?, ?, ?, ?)'
).run(Math.min(a, b), Math.max(a, b), 'friend', adminId).lastInsertRowid;
insertEdge(c1, c2);
insertEdge(c2, c3);
insertEdge(c1, cHidden);

database.prepare(
  'INSERT INTO contact_interactions (contact_id, type, note, occurred_at, created_by) VALUES (?, ?, ?, ?, ?)'
).run(c3, 'note', `${TAG}interaction-c3`, '2024-01-10', adminId);
database.prepare(
  'INSERT INTO contact_interactions (contact_id, type, note, occurred_at, created_by) VALUES (?, ?, ?, ?, ?)'
).run(c1, 'note', `${TAG}interaction-c1`, '2024-02-10', adminId);

database.prepare(
  'INSERT INTO anniversaries (contact_id, title, anniversary_date, created_by) VALUES (?, ?, ?, ?)'
).run(c3, `${TAG}anniv-c3`, '03-15', adminId);
database.prepare(
  'INSERT INTO anniversaries (contact_id, title, anniversary_date, created_by) VALUES (?, ?, ?, ?)'
).run(c1, `${TAG}anniv-c1`, '05-20', adminId);

database.prepare(
  'INSERT INTO contact_preferences (contact_id, interests) VALUES (?, ?)'
).run(c3, `${TAG}prefs-c3`);

function mkApp(userId, role, withUid = true) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (withUid) {
      req.authUserId = userId;
      req.authRole = role;
      req.session = { userId, role };
    } else {
      req.session = {}; // 会话存在但无 userId → fail-closed
    }
    next();
  });
  app.use('/relationships', relationshipsRouter);
  return app;
}

const adminApp = mkApp(adminId, 'admin');
const memberApp = mkApp(memberUserId, 'member');
const anonApp = mkApp(null, null, false);

// Hinweis: die Server werden sequenziell gestartet (await zwischen den listen-
// Aufrufen) — zwei listen()-Aufgaben im selben Tick lassen das 'listening'-
// Event des zweiten Servers auf Node 24 nicht feuern.
const adminServer = adminApp.listen(0, '127.0.0.1');
await new Promise((r) => adminServer.once('listening', r));
const memberServer = memberApp.listen(0, '127.0.0.1');
await new Promise((r) => memberServer.once('listening', r));
const anonServer = anonApp.listen(0, '127.0.0.1');
await new Promise((r) => anonServer.once('listening', r));
const adminBase = `http://127.0.0.1:${adminServer.address().port}/relationships`;
const memberBase = `http://127.0.0.1:${memberServer.address().port}/relationships`;
const anonBase = `http://127.0.0.1:${anonServer.address().port}/relationships`;

const jget = async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => null) }; };
const jsend = async (u, method, body) => {
  const r = await fetch(u, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const raw = async (u) => {
  const r = await fetch(u);
  return { status: r.status, text: await r.text(), contentType: r.headers.get('content-type'), contentDisposition: r.headers.get('content-disposition') };
};

const hasId = (rows, id) => rows.some((r) => r.id === id);

// ========================================================
console.log('\n-- 1. GET /meta/options: Enum-Einzelsquelle --');
// ========================================================
await asyncTest('meta/options enthält zodiacs/constellations（各 12 值）+ 既有键', async () => {
  const { status, body } = await jget(`${adminBase}/meta/options`);
  assert(status === 200, `status ${status}`);
  const d = body.data;
  assert(Array.isArray(d.zodiacs) && d.zodiacs.length === 12, 'zodiacs != 12');
  assert(Array.isArray(d.constellations) && d.constellations.length === 12, 'constellations != 12');
  assert(d.zodiacs[0] === '鼠' && d.zodiacs[11] === '猪', 'zodiac order');
  assert(d.constellations[0] === '白羊座' && d.constellations[11] === '双鱼座', 'constellation order');
  assert(typeof d.photoMaxBytes === 'number', 'photoMaxBytes missing');
  assert(Array.isArray(d.acceptedImageTypes) && d.acceptedImageTypes.length === 4, 'acceptedImageTypes missing');
  assert(Array.isArray(d.relationTypes) && d.relationTypes.includes('spouse'), 'relationTypes missing');
  assert(Array.isArray(d.interactionTypes) && d.interactionTypes.includes('note'), 'interactionTypes missing');
});

// ========================================================
console.log('\n-- 2. PATCH /contacts/:id: 5 新字段 + 加密 + 派生 --');
// ========================================================
await asyncTest('PATCH：5 新字段 + 生日自动换算 + vehiclePlate 加密落库 + 响应解密', async () => {
  const { status, body } = await jsend(`${adminBase}/contacts/${c1}`, 'PATCH', {
    vehiclePlate: '京A12345',
    birthday: '1990-05-20',
    spouseNote: 'Hinweis fuer Familie',
    priorityIntro: true,
  });
  assert(status === 200, `status ${status}`);
  const d = body.data;
  // R3: 响应解密回显
  assert(d.vehicle_plate === '京A12345', `vehicle_plate response: ${d.vehicle_plate}`);
  // R4: 派生字段自动换算
  assert(d.birthday_lunar === '1990-04-26', `birthday_lunar: ${d.birthday_lunar}`);
  assert(d.zodiac === '马', `zodiac: ${d.zodiac}`);
  assert(d.constellation === '金牛座', `constellation: ${d.constellation}`);
  assert(d.spouse_note === 'Hinweis fuer Familie', `spouse_note: ${d.spouse_note}`);
  assert(d.priority_intro === 1, `priority_intro: ${d.priority_intro}`);
  // phone_hash 是内部盲指纹，不出现在响应中（与 contacts.js presentContact 一致）
  assert(!('phone_hash' in d), 'phone_hash leaked into response');
  // R3: 落库为密文
  const row = database.prepare('SELECT vehicle_plate FROM contacts WHERE id = ?').get(c1);
  assert(isCipher(row.vehicle_plate), `vehicle_plate not ciphertext: ${row.vehicle_plate}`);
  assert(row.vehicle_plate !== '京A12345', 'vehicle_plate stored in plaintext');
  assert(decryptField(row.vehicle_plate) === '京A12345', 'vehicle_plate ciphertext does not decrypt');
});

await asyncTest('PATCH：zodiac 非法值 → 400；constellation 非法值 → 400', async () => {
  let r = await jsend(`${adminBase}/contacts/${c2}`, 'PATCH', { zodiac: '龙年' });
  assert(r.status === 400, `zodiac invalid status ${r.status}`);
  assert(/Zodiac/.test(r.body.error), `zodiac error msg: ${r.body.error}`);
  r = await jsend(`${adminBase}/contacts/${c2}`, 'PATCH', { constellation: '狮子' });
  assert(r.status === 400, `constellation invalid status ${r.status}`);
  assert(/Constellation/.test(r.body.error), `constellation error msg: ${r.body.error}`);
});

await asyncTest('PATCH：priorityIntro 非布尔 → 400', async () => {
  const r = await jsend(`${adminBase}/contacts/${c2}`, 'PATCH', { priorityIntro: 'yes' });
  assert(r.status === 400, `status ${r.status}`);
  assert(/Priority intro/.test(r.body.error), `error msg: ${r.body.error}`);
});

await asyncTest('PATCH：显式派生字段优先于自动换算；未动生日不算术', async () => {
  // 只显式传 zodiac（无 birthday）→ 仅 zodiac 写入，其余派生不动
  let r = await jsend(`${adminBase}/contacts/${c2}`, 'PATCH', { zodiac: '龙' });
  assert(r.status === 200, `status ${r.status}`);
  assert(r.body.data.zodiac === '龙', `zodiac: ${r.body.data.zodiac}`);
  assert(r.body.data.birthday_lunar === null, `birthday_lunar should stay null: ${r.body.data.birthday_lunar}`);
  // 生日变更 + 显式 constellation → 显式值赢，其余自动换算
  r = await jsend(`${adminBase}/contacts/${c2}`, 'PATCH', { birthday: '1988-03-15', constellation: '双鱼座' });
  assert(r.status === 200, `status ${r.status}`);
  assert(r.body.data.birthday_lunar === '1988-01-28', `birthday_lunar: ${r.body.data.birthday_lunar}`);
  assert(r.body.data.zodiac === '龙', `zodiac auto: ${r.body.data.zodiac}`);
  assert(r.body.data.constellation === '双鱼座', `constellation explicit: ${r.body.data.constellation}`);
});

await asyncTest('PATCH：清空生日 → 派生字段置 NULL', async () => {
  const r = await jsend(`${adminBase}/contacts/${c2}`, 'PATCH', { birthday: null });
  assert(r.status === 200, `status ${r.status}`);
  assert(r.body.data.birthday === null, 'birthday not cleared');
  assert(r.body.data.birthday_lunar === null, `birthday_lunar: ${r.body.data.birthday_lunar}`);
  assert(r.body.data.zodiac === null, `zodiac: ${r.body.data.zodiac}`);
  assert(r.body.data.constellation === null, `constellation: ${r.body.data.constellation}`);
});

await asyncTest('PATCH：无字段 → 400；不存在 → 404；logOp 落审计', async () => {
  let r = await jsend(`${adminBase}/contacts/${c2}`, 'PATCH', {});
  assert(r.status === 400, `empty patch status ${r.status}`);
  r = await jsend(`${adminBase}/contacts/99999999`, 'PATCH', { school: 'x' });
  assert(r.status === 404, `missing contact status ${r.status}`);
  const logs = database.prepare(
    "SELECT summary FROM relationship_op_log WHERE entity = 'contact' AND entity_id = ? ORDER BY id DESC"
  ).all(c1);
  assert(logs.length > 0, 'no op-log for contact update');
  assert(/vehicle_plate/.test(logs[0].summary), `op-log summary: ${logs[0].summary}`);
});

await asyncTest('PATCH：hidden 非 admin → 403（既有行为保持）', async () => {
  const r = await jsend(`${memberBase}/contacts/${c1}`, 'PATCH', { hidden: true });
  assert(r.status === 403, `status ${r.status}`);
});

// ========================================================
console.log('\n-- 3. 分组 7 端点全流程 --');
// ========================================================
let groupA = 0, groupB = 0, groupAuto = 0;
await asyncTest('POST /groups：建两个组；重名（COLLATE NOCASE）→ 409', async () => {
  let r = await jsend(`${adminBase}/groups`, 'POST', { name: `${TAG}Familie`, color: '#ff0000', sortOrder: 2 });
  assert(r.status === 201, `create A status ${r.status}`);
  groupA = r.body.data.id;
  assert(r.body.data.name === `${TAG}Familie` && r.body.data.sort_order === 2, 'group A fields');
  assert(r.body.data.created_by === adminId, `created_by: ${r.body.data.created_by}`);
  r = await jsend(`${adminBase}/groups`, 'POST', { name: `${TAG}Freunde` });
  assert(r.status === 201, `create B status ${r.status}`);
  groupB = r.body.data.id;
  r = await jsend(`${adminBase}/groups`, 'POST', { name: `${TAG}fAMILIE` });
  assert(r.status === 409, `dup status ${r.status}`);
});

await asyncTest('PUT /groups/:id：改名/改色/排序；重名 409', async () => {
  let r = await jsend(`${adminBase}/groups/${groupA}`, 'PUT', { color: '#00ff00', sortOrder: 5 });
  assert(r.status === 200, `update status ${r.status}`);
  assert(r.body.data.color === '#00ff00' && r.body.data.sort_order === 5, 'update fields');
  r = await jsend(`${adminBase}/groups/${groupA}`, 'PUT', { name: `${TAG}freunde` });
  assert(r.status === 409, `rename dup status ${r.status}`);
  r = await jsend(`${adminBase}/groups/${groupA}`, 'PUT', {});
  assert(r.status === 400, `empty update status ${r.status}`);
  r = await jsend(`${adminBase}/groups/99999999`, 'PUT', { color: '#000000' });
  assert(r.status === 404, `missing group status ${r.status}`);
});

await asyncTest('POST /contacts/:id/groups：groupId 绑定 + name 自动建组绑定（INSERT OR IGNORE）', async () => {
  let r = await jsend(`${adminBase}/contacts/${c1}/groups`, 'POST', { groupId: groupA });
  assert(r.status === 201, `bind by id status ${r.status}`);
  assert(r.body.data.contactId === c1 && r.body.data.groupId === groupA, 'bind payload');
  // 幂等：重复绑定不报错（INSERT OR IGNORE）
  r = await jsend(`${adminBase}/contacts/${c1}/groups`, 'POST', { groupId: groupA });
  assert(r.status === 201, `rebind status ${r.status}`);
  // name 不存在 → 自动创建后绑定（照 tags 语义）
  r = await jsend(`${adminBase}/contacts/${c1}/groups`, 'POST', { name: `${TAG}Verwandtschaft` });
  assert(r.status === 201, `bind by name status ${r.status}`);
  groupAuto = r.body.data.groupId;
  assert(Number.isInteger(groupAuto), 'auto group id');
  // 不存在的 groupId → 404（FK 开启，不能静默 500）
  r = await jsend(`${adminBase}/contacts/${c1}/groups`, 'POST', { groupId: 99999999 });
  assert(r.status === 404, `unknown group status ${r.status}`);
  // 不存在的联系人 → 404
  r = await jsend(`${adminBase}/contacts/99999999/groups`, 'POST', { groupId: groupA });
  assert(r.status === 404, `unknown contact status ${r.status}`);
  // 两者皆无 → 400
  r = await jsend(`${adminBase}/contacts/${c1}/groups`, 'POST', {});
  assert(r.status === 400, `no groupId/name status ${r.status}`);
});

await asyncTest('GET /groups + GET /contacts/:id/groups：usage 计数与绑定列表', async () => {
  const { status, body } = await jget(`${adminBase}/groups`);
  assert(status === 200, `status ${status}`);
  const ga = body.data.find((g) => g.id === groupA);
  assert(ga && ga.usage === 1, `usage: ${ga?.usage}`);
  const gauto = body.data.find((g) => g.id === groupAuto);
  assert(gauto && gauto.usage === 1, `auto usage: ${gauto?.usage}`);
  // 排序：sort_order ASC, name COLLATE NOCASE
  const orders = body.data.map((g) => g.sort_order);
  assert(orders.every((v, i) => i === 0 || orders[i - 1] <= v), 'sort_order not ascending');

  const cg = await jget(`${adminBase}/contacts/${c1}/groups`);
  assert(cg.status === 200, `contact groups status ${cg.status}`);
  const names = cg.body.data.map((g) => g.name);
  assert(names.includes(`${TAG}Familie`) && names.includes(`${TAG}Verwandtschaft`), `contact groups: ${names}`);
  // 不可见联系人的分组列表 → 404
  const hidden = await jget(`${memberBase}/contacts/${cHidden}/groups`);
  assert(hidden.status === 404, `hidden contact groups status ${hidden.status}`);
});

await asyncTest('DELETE /contacts/:id/groups/:groupId + DELETE /groups/:id：解绑 + 级联清 map', async () => {
  let r = await jsend(`${adminBase}/contacts/${c1}/groups/${groupB}`, 'DELETE');
  assert(r.status === 204, `unbind status ${r.status}`);
  const bound = database.prepare('SELECT 1 FROM contact_group_map WHERE contact_id = ? AND group_id = ?').get(c1, groupB);
  assert(!bound, 'map row still bound after unbind');
  r = await jsend(`${adminBase}/groups/${groupAuto}`, 'DELETE');
  assert(r.status === 204, `delete group status ${r.status}`);
  const mapRows = database.prepare('SELECT COUNT(*) AS n FROM contact_group_map WHERE group_id = ?').get(groupAuto).n;
  assert(mapRows === 0, `map rows after group delete: ${mapRows}`);
  const groupRow = database.prepare('SELECT 1 FROM contact_groups WHERE id = ?').get(groupAuto);
  assert(!groupRow, 'group row still exists after delete');
  r = await jsend(`${adminBase}/groups/${groupAuto}`, 'DELETE');
  assert(r.status === 404, `delete missing group status ${r.status}`);
});

await asyncTest('分组写操作落 logOp', async () => {
  const logs = database.prepare(
    "SELECT action, entity FROM relationship_op_log WHERE entity IN ('contact_group', 'contact_group_map') ORDER BY id DESC LIMIT 30"
  ).all();
  assert(logs.length >= 3, 'group op-log missing');
  assert(logs.some((l) => l.action === 'create' && l.entity === 'contact_group'), 'create log missing');
  assert(logs.some((l) => l.action === 'delete' && l.entity === 'contact_group'), 'delete log missing');
});

// ========================================================
console.log('\n-- 4. contact-visibility.js 服务函数（mock req） --');
// ========================================================
await asyncTest('visibilityFilter/isVisible/visibleIdSet：admin / member / 无 uid', async () => {
  const adminReq = { authRole: 'admin', authUserId: adminId };
  const memberReq = { authRole: 'member', authUserId: memberUserId };
  const anonReq = {};
  assert(visibilityFilter(adminReq, 'c').sql === '', 'admin filter not empty');
  assert(visibilityFilter(adminReq, 'c').params.length === 0, 'admin params not empty');
  const mem = visibilityFilter(memberReq, 'c');
  assert(mem.sql.includes('c.hidden = 0') && mem.sql.includes('contact_node_acl'), `member filter: ${mem.sql}`);
  assert(mem.params[0] === memberUserId, 'member filter param');
  assert(visibilityFilter(anonReq, 'c').sql === ' AND 1=0', 'anon not fail-closed');
  assert(visibleIdSet(adminReq) === null, 'admin id set not null');
  assert(visibleIdSet(anonReq).size === 0, 'anon id set not empty');
  assert(isVisible(adminReq, cHidden) === true, 'admin should see hidden');
  assert(isVisible(memberReq, cHidden) === false, 'member should not see hidden');
  assert(isVisible(memberReq, c1) === true, 'member should see normal');
  assert(isVisible(anonReq, c1) === false, 'anon should see nothing');
  assert(isVisible(memberReq, 99999999) === false, 'missing contact should be invisible');
});

// ========================================================
console.log('\n-- 5. ACL 4 端点：403 / 建规则 / 屏蔽生效 / 删除恢复 --');
// ========================================================
await asyncTest('ACL：非 admin 调 4 端点全 403', async () => {
  for (const [method, url] of [
    ['GET', `${memberBase}/acl`],
    ['GET', `${memberBase}/acl/users`],
    ['POST', `${memberBase}/acl`],
    ['DELETE', `${memberBase}/acl/1`],
  ]) {
    const r = await jsend(url, method, method === 'POST' ? { contactId: c1, userId: memberUserId } : undefined);
    assert(r.status === 403, `${method} ${url} → ${r.status}`);
    assert(r.body.error === 'Only admins can manage visibility.', `${method} error msg: ${r.body.error}`);
  }
});

let aclRuleId = 0;
await asyncTest('ACL：admin 建规则（201）→ 屏蔽用户全部读端点不可见 → DELETE 恢复', async () => {
  // 建规则前：member 能看到 c3（边 c2-c3、生日、互动、纪念日、偏好）
  let edges = await jget(`${memberBase}/`);
  assert(edges.body.data.some((e) => e.contact_a === Math.min(c2, c3) && e.contact_b === Math.max(c2, c3)), 'member should see c2-c3 edge before ACL');
  let reminders = await jget(`${memberBase}/reminders`);
  assert(reminders.body.data.birthdays.some((b) => b.id === c3), 'member should see c3 birthday before ACL');
  let prefs = await jget(`${memberBase}/preferences?contactId=${c3}`);
  assert(prefs.status === 200, `prefs before ACL status ${prefs.status}`);

  const created = await jsend(`${adminBase}/acl`, 'POST', { contactId: c3, userId: memberUserId });
  assert(created.status === 201, `create acl status ${created.status}`);
  aclRuleId = created.body.data.id;
  assert(created.body.data.contact_id === c3 && created.body.data.user_id === memberUserId, 'acl payload');
  assert(created.body.data.created_by === adminId, 'acl created_by');

  // 重复 → 409
  const dup = await jsend(`${adminBase}/acl`, 'POST', { contactId: c3, userId: memberUserId });
  assert(dup.status === 409, `dup acl status ${dup.status}`);
  // 不存在的联系人/用户 → 404；缺字段 → 400
  assert((await jsend(`${adminBase}/acl`, 'POST', { contactId: 99999999, userId: memberUserId })).status === 404, 'acl unknown contact');
  assert((await jsend(`${adminBase}/acl`, 'POST', { contactId: c1, userId: 99999999 })).status === 404, 'acl unknown user');
  assert((await jsend(`${adminBase}/acl`, 'POST', { contactId: c1 })).status === 400, 'acl missing userId');

  // 屏蔽生效：member 各读端点不见 c3 及其边
  edges = await jget(`${memberBase}/`);
  assert(!edges.body.data.some((e) => e.contact_a === Math.min(c2, c3) && e.contact_b === Math.max(c2, c3)), 'member still sees c2-c3 edge after ACL');
  assert(edges.body.data.some((e) => e.contact_a === Math.min(c1, c2) && e.contact_b === Math.max(c1, c2)), 'member lost visible c1-c2 edge');

  const graph = await jget(`${memberBase}/graph`);
  assert(!graph.body.data.nodes.some((n) => n.id === c3), 'c3 still in graph nodes');
  assert(graph.body.data.nodes.some((n) => n.id === c1), 'c1 missing from graph nodes');
  assert(!graph.body.data.edges.some((e) => e.contact_a === c3 || e.contact_b === c3), 'c3 edge still in graph');

  const common = await jget(`${memberBase}/common`);
  assert(!common.body.data.some((r) => r.contactA.id === c3 || r.contactB.id === c3), 'c3 in common results');
  const commonFocus = await jget(`${memberBase}/common?contactId=${c3}`);
  assert(commonFocus.body.data.length === 0, 'common focus on blocked contact not empty');

  const tree = await jget(`${memberBase}/tree`);
  assert(!tree.body.data.sources.some((s) => s.id === c3), 'c3 in tree sources');
  assert(!tree.body.data.branches.some((b) => b.connections.some((cn) => cn.contactId === c3)), 'c3 in tree connections');

  reminders = await jget(`${memberBase}/reminders`);
  assert(!reminders.body.data.birthdays.some((b) => b.id === c3), 'c3 birthday still in reminders');
  assert(reminders.body.data.birthdays.some((b) => b.id === c1), 'c1 birthday missing from reminders');
  assert(!reminders.body.data.anniversaries.some((a) => a.contact_name && a.title === `${TAG}anniv-c3`), 'c3 anniversary still in reminders');
  assert(!reminders.body.data.stale.some((s) => s.id === c3), 'c3 still in stale');

  const insights = await jget(`${memberBase}/insights`);
  assert(!insights.body.data.closeness.some((x) => x.id === c3), 'c3 in closeness');
  assert(!insights.body.data.stale.some((x) => x.id === c3), 'c3 in insights stale');
  assert(insights.body.data.closeness.some((x) => x.id === c1), 'c1 missing from closeness');

  const interactions = await jget(`${memberBase}/interactions`);
  assert(!interactions.body.data.some((i) => i.contact_id === c3), 'c3 interaction still visible');
  assert(interactions.body.data.some((i) => i.contact_id === c1), 'c1 interaction missing');

  const anniversaries = await jget(`${memberBase}/anniversaries`);
  assert(!anniversaries.body.data.some((a) => a.title === `${TAG}anniv-c3`), 'c3 anniversary still visible');
  assert(anniversaries.body.data.some((a) => a.title === `${TAG}anniv-c1`), 'c1 anniversary missing');

  prefs = await jget(`${memberBase}/preferences?contactId=${c3}`);
  assert(prefs.status === 404, `prefs after ACL status ${prefs.status}`);
  const tags = await jget(`${memberBase}/contacts/${c3}/tags`);
  assert(tags.status === 404, `tags after ACL status ${tags.status}`);
  const groups = await jget(`${memberBase}/contacts/${c3}/groups`);
  assert(groups.status === 404, `groups after ACL status ${groups.status}`);

  // admin 视野不受影响
  const adminEdges = await jget(`${adminBase}/`);
  assert(adminEdges.body.data.some((e) => e.contact_a === Math.min(c2, c3) && e.contact_b === Math.max(c2, c3)), 'admin lost c2-c3 edge');
  const adminPrefs = await jget(`${adminBase}/preferences?contactId=${c3}`);
  assert(adminPrefs.status === 200, `admin prefs status ${adminPrefs.status}`);

  // DELETE 规则 → member 恢复可见
  const del = await jsend(`${adminBase}/acl/${aclRuleId}`, 'DELETE');
  assert(del.status === 204, `delete acl status ${del.status}`);
  const delAgain = await jsend(`${adminBase}/acl/${aclRuleId}`, 'DELETE');
  assert(delAgain.status === 404, `delete missing acl status ${delAgain.status}`);
  edges = await jget(`${memberBase}/`);
  assert(edges.body.data.some((e) => e.contact_a === Math.min(c2, c3) && e.contact_b === Math.max(c2, c3)), 'c2-c3 edge not restored');
  prefs = await jget(`${memberBase}/preferences?contactId=${c3}`);
  assert(prefs.status === 200, `prefs not restored: ${prefs.status}`);
});

await asyncTest('ACL：GET /acl 列表 + GET /acl/users（排除 admin 自身）', async () => {
  const rule = await jsend(`${adminBase}/acl`, 'POST', { contactId: cHidden, userId: memberUserId });
  assert(rule.status === 201, `re-create rule status ${rule.status}`);
  const list = await jget(`${adminBase}/acl`);
  assert(list.status === 200, `acl list status ${list.status}`);
  const mine = list.body.data.find((r) => r.id === rule.body.data.id);
  assert(mine && mine.contact_name === `${TAG}Ghost` && mine.username === 'rel-member', `acl list join: ${JSON.stringify(mine)}`);
  // id DESC
  const ids = list.body.data.map((r) => r.id);
  assert(ids.every((v, i) => i === 0 || ids[i - 1] >= v), 'acl list not id DESC');
  const users = await jget(`${adminBase}/acl/users`);
  assert(users.status === 200, `acl users status ${users.status}`);
  assert(!users.body.data.some((u) => u.id === adminId), 'admin self not excluded');
  assert(users.body.data.some((u) => u.id === memberUserId), 'member missing from acl users');
  assert(users.body.data.every((u) => 'username' in u && 'role' in u && 'display_name' in u), 'acl users fields');
  await jsend(`${adminBase}/acl/${rule.body.data.id}`, 'DELETE');
});

await asyncTest('ACL：GET /acl?contactId= 按联系人过滤（BUG-1 回归：全量 vs 过滤 vs 空列 vs 非法）', async () => {
  // 两条规则分属两个联系人；副本模式下按本 run 自建 ID 收敛，互不干扰
  const ruleA = await jsend(`${adminBase}/acl`, 'POST', { contactId: cHidden, userId: memberUserId });
  assert(ruleA.status === 201, `rule A status ${ruleA.status}`);
  const ruleB = await jsend(`${adminBase}/acl`, 'POST', { contactId: c1, userId: memberUserId });
  assert(ruleB.status === 201, `rule B status ${ruleB.status}`);
  try {
    // 全量列表：两条均在（缺省参数行为不变）
    const all = await jget(`${adminBase}/acl`);
    assert(all.status === 200, `full list status ${all.status}`);
    assert(all.body.data.some((r) => r.id === ruleA.body.data.id), 'rule A missing from full list');
    assert(all.body.data.some((r) => r.id === ruleB.body.data.id), 'rule B missing from full list');

    // ?contactId=cHidden → 仅 1 条且属 cHidden（BUG-1 场景：修复前掺入 c1 规则返回 2 条）
    const fA = await jget(`${adminBase}/acl?contactId=${cHidden}`);
    assert(fA.status === 200, `filter cHidden status ${fA.status}`);
    assert(fA.body.data.length === 1, `filter cHidden rows: ${fA.body.data.length}`);
    assert(fA.body.data[0].id === ruleA.body.data.id, 'filter cHidden returned wrong rule');
    assert(fA.body.data.every((r) => r.contact_id === cHidden), 'filter cHidden mixed other contacts');

    // ?contactId=c1 → 仅 c1 的规则
    const fB = await jget(`${adminBase}/acl?contactId=${c1}`);
    assert(fB.status === 200, `filter c1 status ${fB.status}`);
    assert(fB.body.data.length === 1 && fB.body.data[0].id === ruleB.body.data.id, 'filter c1 wrong');

    // ?contactId=99999999 → 无规则 → 空列表（BUG-1 铁证场景：修复前返回全量）
    const fNone = await jget(`${adminBase}/acl?contactId=99999999`);
    assert(fNone.status === 200, `empty filter status ${fNone.status}`);
    assert(Array.isArray(fNone.body.data) && fNone.body.data.length === 0, `empty filter rows: ${fNone.body.data?.length}`);

    // 非法 contactId → 400（不静默回落全量，避免客户端误用拿到错误数据）
    const fBad = await jget(`${adminBase}/acl?contactId=abc`);
    assert(fBad.status === 400, `invalid contactId status ${fBad.status}`);
    assert(/contactId/.test(fBad.body.error), `invalid contactId msg: ${fBad.body.error}`);
  } finally {
    await jsend(`${adminBase}/acl/${ruleA.body.data.id}`, 'DELETE');
    await jsend(`${adminBase}/acl/${ruleB.body.data.id}`, 'DELETE');
  }
});

// ========================================================
console.log('\n-- 6. tree-export 可见性 + fail-closed --');
// ========================================================
await asyncTest('tree-export：member 不见 hidden/被屏蔽联系人；admin 全量', async () => {
  const memberExport = await raw(`${memberBase}/tree-export`);
  assert(memberExport.status === 200, `export status ${memberExport.status}`);
  assert(/attachment/.test(memberExport.contentDisposition || ''), `content-disposition: ${memberExport.contentDisposition}`);
  const payload = JSON.parse(memberExport.text);
  const ids = payload.nodes.map((n) => n.id);
  assert(!ids.includes(cHidden), 'hidden contact in member export');
  assert(ids.includes(c1), 'visible contact missing from member export');
  const edgeHasHidden = payload.edges.some((e) => e.contact_a === cHidden || e.contact_b === cHidden);
  assert(!edgeHasHidden, 'hidden edge in member export');
  // 导出无密文列（id/name/photo/category/relationship_type）——无需解密
  assert(!('phone' in payload.nodes[0]) && !('vehicle_plate' in payload.nodes[0]), 'export contains encrypted columns');

  const adminExport = await raw(`${adminBase}/tree-export`);
  const adminPayload = JSON.parse(adminExport.text);
  assert(adminPayload.nodes.map((n) => n.id).includes(cHidden), 'admin export missing hidden contact');
});

await asyncTest('fail-closed：无 uid 的 HTTP 请求 → 边列表空（AND 1=0）', async () => {
  const r = await jget(`${anonBase}/`);
  assert(r.status === 200, `status ${r.status}`);
  assert(Array.isArray(r.body.data) && r.body.data.length === 0, 'anon request leaked edges');
});

// ========================================================
console.log(`\n[Relationships-Groups-ACL-Test] ${passed} passed, ${failed} failed\n`);
// ========================================================
adminServer.close();
memberServer.close();
anonServer.close();
process.exit(failed === 0 ? 0 : 1);
