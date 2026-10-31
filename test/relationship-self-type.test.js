/**
 * 测试：人际关系 D 组 —— 'self' 关系类型端到端接受（强化 D1）
 *
 * D1（relationship-fixes.test.js）仅校验 meta/options 的 relationTypes 含
 * 'self'；本文件进一步验证 POST /relationships 能接受并落库
 * relation_type='self'，确保前后端一致、服务端不拒绝该类型。回归意义：
 * 若将来有人给服务端加 relation_type 白名单却漏掉 'self'，此用例会先红。
 *
 * 模式：node:test + node:assert/strict，零新依赖。DB_PATH 指向临时库，
 *       最小 schema 经 _setTestDatabase 注入（与 relationship-fixes.test.js、
 *       media-emby.test.js 一致）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const SKIP = NODE_MAJOR >= 22
  ? false
  : `better-sqlite3-multiple-ciphers 需要 Node >= 22（当前 v${process.versions.node}），跳过 self 类型用例`;

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'juju-self-test-')), 'yuvomi.db');
process.env.LOG_LEVEL = 'error';

const SCHEMA = `
  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    name TEXT
  );
  CREATE TABLE contact_relationships (
    id INTEGER PRIMARY KEY,
    contact_a INTEGER,
    contact_b INTEGER,
    relation_type TEXT,
    note TEXT,
    strength INTEGER,
    met_at TEXT,
    direction TEXT,
    label TEXT,
    created_by INTEGER
  );
  CREATE TABLE relationship_op_log (
    id INTEGER PRIMARY KEY,
    actor_uid INTEGER,
    actor_name TEXT,
    action TEXT,
    entity TEXT,
    entity_id INTEGER,
    summary TEXT
  );
`;

/**
 * 起一个临时 express 实例，挂载 relationships router，以管理员身份访问。
 */
async function startApp() {
  const [{ _setTestDatabase }, DatabaseMod, expressMod] = await Promise.all([
    import('../server/db.js'),
    import('better-sqlite3-multiple-ciphers'),
    import('express'),
  ]);
  const Database = DatabaseMod.default;
  const testDb = new Database(':memory:');
  testDb.exec(SCHEMA);
  _setTestDatabase(testDb);

  const router = (await import('../server/routes/relationships.js')).default;
  const express = expressMod.default;
  const app = express();
  app.use(express.json());
  // 以管理员身份访问（绕过可见性过滤）。
  app.use((req, res, next) => { req.authRole = 'admin'; req.authUserId = 1; next(); });
  app.use('/api/v1/relationships', router);

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl, testDb };
}

// ------------------------------------------------------------
// 强化 D1：'self' 关系类型端到端
// ------------------------------------------------------------
test('D1+: POST /relationships 接受 relation_type="self" 并落库', { skip: SKIP }, async () => {
  const { server, baseUrl, testDb } = await startApp();
  try {
    testDb.prepare("INSERT INTO contacts (id, name) VALUES (1, 'Alice'), (2, 'Bob')").run();

    const res = await fetch(`${baseUrl}/api/v1/relationships`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_a: 1, contact_b: 2, relation_type: 'self' }),
    });
    assert.equal(res.status, 201, 'self 类型应被接受（201，而非被服务端拒绝）');
    const json = await res.json();
    assert.equal(json.data?.relation_type, 'self', '落库的关系类型应为 self');

    // 再从库里读回，确认确实持久化。
    const row = testDb
      .prepare('SELECT relation_type FROM contact_relationships WHERE id = ?')
      .get(json.data.id);
    assert.equal(row.relation_type, 'self', 'contact_relationships 中应存为 self');
  } finally {
    server.close();
  }
});

test('D1+: POST /relationships 缺省 relation_type 回退为 knows', { skip: SKIP }, async () => {
  const { server, baseUrl, testDb } = await startApp();
  try {
    testDb.prepare("INSERT INTO contacts (id, name) VALUES (3, 'Carol'), (4, 'Dave')").run();

    const res = await fetch(`${baseUrl}/api/v1/relationships`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_a: 3, contact_b: 4 }),
    });
    assert.equal(res.status, 201, '无类型时仍应成功（201）');
    const json = await res.json();
    assert.equal(json.data?.relation_type, 'knows', '缺省应回退到 knows');
  } finally {
    server.close();
  }
});
