/**
 * 测试：人际关系模块 D 组修复回归
 *
 * 覆盖：
 *   D1：关系类型新增「自己」(self) —— /meta/options 的 relationTypes 必须包含
 *       'self'，保证前端下拉与服务端校验一致（server/routes/relationships.js）。
 *   D3 根因2：联系人 GET 不再按 housekeeping_workers 过滤 —— 此前
 *       `NOT EXISTS(hw.user_id = contacts.family_user_id)` 会把“也是家政人员”
 *       的家庭成员名下所有联系人误排除（联系人不同步）。修复后，即使是家政
 *       人员账号名下的联系人，也应随 GET /contacts 正常返回。
 *
 * 模式：node:test + node:assert/strict，零新依赖。DB_PATH 指向临时库，
 *       最小 schema 经 _setTestDatabase 注入（与 media-emby.test.js 一致）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const SKIP = NODE_MAJOR >= 22
  ? false
  : `better-sqlite3-multiple-ciphers 需要 Node >= 22（当前 v${process.versions.node}），跳过 D 组用例`;

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'juju-d-test-')), 'yuvomi.db');
process.env.LOG_LEVEL = 'error';

/**
 * 起一个临时 express 实例，挂载给定 router，并以管理员身份访问（绕过可见性
 * 过滤，仅验证“worker 过滤已移除”这一行为）。返回 server / baseUrl / testDb。
 * @param {string} routerPath 形如 '../server/routes/contacts.js'
 * @param {string} schemaSql 最小建表语句
 */
async function startApp(routerPath, mountPath, schemaSql) {
  const [{ _setTestDatabase }, DatabaseMod, expressMod] = await Promise.all([
    import('../server/db.js'),
    import('better-sqlite3-multiple-ciphers'),
    import('express'),
  ]);
  const Database = DatabaseMod.default;
  const testDb = new Database(':memory:');
  testDb.exec(schemaSql);
  _setTestDatabase(testDb);

  const router = (await import(routerPath)).default;
  const express = expressMod.default;
  const app = express();
  app.use(express.json());
  // 以管理员身份访问，绕过 contact_node_acl / hidden 过滤（这些与 worker 过滤无关）。
  app.use((req, res, next) => { req.authRole = 'admin'; req.authUserId = 1; next(); });
  app.use(mountPath, router);

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl, testDb };
}

const CONTACTS_SCHEMA = `
  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    name TEXT, category TEXT, phone TEXT, address TEXT, vehicle_plate TEXT,
    email TEXT, notes TEXT, hidden INTEGER DEFAULT 0, family_user_id INTEGER,
    last_name TEXT, photo TEXT, relationship_type TEXT, birthday TEXT
  );
  CREATE TABLE housekeeping_workers (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE
  );
`;

// ------------------------------------------------------------
// D1: relationTypes 包含 'self'
// ------------------------------------------------------------
test('D1: GET /meta/options 的 relationTypes 包含 self（关系类型“自己”）', { skip: SKIP }, async () => {
  const { server, baseUrl } = await startApp(
    '../server/routes/relationships.js',
    '/api/v1/relationships',
    'CREATE TABLE contacts (id INTEGER PRIMARY KEY);',
  );
  try {
    const res = await fetch(`${baseUrl}/api/v1/relationships/meta/options`);
    assert.equal(res.status, 200, 'meta/options 应返回 200');
    const json = await res.json();
    assert.ok(Array.isArray(json.data?.relationTypes), 'relationTypes 应为数组');
    assert.ok(
      json.data.relationTypes.includes('self'),
      `relationTypes 应包含 'self'（实际：${JSON.stringify(json.data.relationTypes)}）`,
    );
  } finally {
    server.close();
  }
});

// ------------------------------------------------------------
// D3 根因2：联系人 GET 不再按 housekeeping_workers 过滤
// ------------------------------------------------------------
test('D3.2: 联系人 GET 不再排除家政人员账号名下的联系人', { skip: SKIP }, async () => {
  const { server, baseUrl, testDb } = await startApp(
    '../server/routes/contacts.js',
    '/api/v1/contacts',
    CONTACTS_SCHEMA,
  );
  try {
    // user_id=7 是家政人员；其名下的联系人（family_user_id=7）此前会被误排除。
    testDb.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (7)').run();
    testDb.prepare(
      "INSERT INTO contacts (id, name, category, family_user_id) VALUES (1, 'Alice', 'family', 7)"
    ).run();
    testDb.prepare(
      "INSERT INTO contacts (id, name, category, family_user_id) VALUES (2, 'Bob', 'family', 2)"
    ).run();

    const res = await fetch(`${baseUrl}/api/v1/contacts`);
    assert.equal(res.status, 200, 'GET /contacts 应返回 200');
    const json = await res.json();
    const names = (json.data || []).map((c) => c.name).sort();
    assert.deepEqual(
      names,
      ['Alice', 'Bob'],
      '家政人员名下的 Alice 也应被返回（修复前被 NOT EXISTS 误排除）',
    );
  } finally {
    server.close();
  }
});
