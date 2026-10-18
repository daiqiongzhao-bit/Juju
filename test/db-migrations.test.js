/**
 * 测试：数据库迁移（server/db.js 的 MIGRATIONS + init/迁移引擎）
 *
 * 覆盖：迁移编号连续无重复、结构完整、在临时库上从零跑到最新版本、
 *       2FA 相关列（v152）确实落地、完整性/外键检查通过、可重复冷启动。
 *
 * 环境：DB_PATH 指向 mkdtemp 生成的临时目录，JUJU_SM4_KEY 注入合法密钥，
 *       不设置 DB_ENCRYPTION_KEY（明文库跑迁移最快），结束后删除临时目录。
 *
 * 说明：better-sqlite3-multiple-ciphers 13.x 要求 Node >= 22（prebuild 的
 *       NODE_MODULE_VERSION 与 Node 20 不兼容，加载即段错误）。因此在低版本
 *       Node 上整组用例跳过并给出原因，而不是伪装成通过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 期望的最新迁移版本（v0.0.29：2FA/TOTP 列）。 */
const EXPECTED_LATEST = 152;
/** v152 落到 users 表上的四个列。 */
const TOTP_COLUMNS = ['totp_secret', 'totp_enabled', 'totp_enabled_at', 'totp_recovery_codes'];

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const DB_SKIP = NODE_MAJOR >= 22
  ? false
  : `better-sqlite3-multiple-ciphers 需要 Node >= 22（当前 v${process.versions.node}），跳过数据库用例`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'juju-migration-test-'));
const dbFile = path.join(workDir, 'yuvomi.db');

const savedEnv = {
  DB_PATH: process.env.DB_PATH,
  JUJU_SM4_KEY: process.env.JUJU_SM4_KEY,
  DB_ENCRYPTION_KEY: process.env.DB_ENCRYPTION_KEY,
  LOG_LEVEL: process.env.LOG_LEVEL,
};

// 必须在 import('../server/db.js') 之前设置：db.js 在模块加载时就解析 DB_PATH。
process.env.DB_PATH = dbFile;
process.env.JUJU_SM4_KEY = '0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL = 'error'; // 152 条迁移日志会淹没测试输出
delete process.env.DB_ENCRYPTION_KEY;

/** 惰性加载 db 模块（模块级会自动 init 并跑迁移）。 */
function loadDb() {
  return import('../server/db.js');
}

test('迁移列表：编号从 1 连续、无重复、结构完整', { skip: DB_SKIP }, async () => {
  const { MIGRATIONS } = await loadDb();

  assert.ok(Array.isArray(MIGRATIONS) && MIGRATIONS.length > 0);
  assert.equal(MIGRATIONS.length, EXPECTED_LATEST);

  const seen = new Set();
  MIGRATIONS.forEach((migration, index) => {
    assert.equal(typeof migration.version, 'number', `第 ${index} 项缺少 version`);
    assert.equal(migration.version, index + 1, `第 ${index} 项版本号应为 ${index + 1}`);
    assert.equal(seen.has(migration.version), false, `版本号 ${migration.version} 重复`);
    seen.add(migration.version);

    assert.equal(typeof migration.description, 'string');
    assert.ok(migration.description.length > 0, `迁移 ${migration.version} 缺少说明`);
    const isSql = typeof migration.up === 'string';
    const isFn = typeof migration.up === 'function';
    assert.ok(isSql || isFn, `迁移 ${migration.version} 的 up 必须是 SQL 或函数`);
    if (isSql) assert.ok(migration.up.trim().length > 0);
  });

  assert.equal(MIGRATIONS[MIGRATIONS.length - 1].version, EXPECTED_LATEST);
});

test('冷启动：空库一次跑到 v152，且 schema_migrations 记录齐全', { skip: DB_SKIP }, async () => {
  const db = await loadDb();

  assert.equal(db.currentVersion(), EXPECTED_LATEST);
  assert.equal(db.getPath(), dbFile);

  const applied = db.get().prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  assert.equal(applied.length, EXPECTED_LATEST);
  assert.equal(applied[0].version, 1);
  assert.equal(applied[applied.length - 1].version, EXPECTED_LATEST);
});

test('v152：users 表上的 2FA 四列确实存在', { skip: DB_SKIP }, async () => {
  const db = await loadDb();
  const columns = db.get().prepare('PRAGMA table_info(users)').all().map((row) => row.name);

  for (const column of TOTP_COLUMNS) {
    assert.ok(columns.includes(column), `users 表缺少列 ${column}`);
  }
});

test('迁移结果：完整性检查与外键检查均通过', { skip: DB_SKIP }, async () => {
  const db = await loadDb();

  const integrity = db.get().pragma('integrity_check');
  const integrityValue = String(Object.values(integrity[0])[0]);
  assert.equal(integrityValue.toLowerCase(), 'ok');

  assert.deepEqual(db.get().pragma('foreign_key_check'), []);
});

test('可重复性：删库后重新 init 仍能一次跑到 v152', { skip: DB_SKIP }, async () => {
  const db = await loadDb();

  db.closeConnection();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbFile}${suffix}`, { force: true });
  }

  db.init();
  assert.equal(db.currentVersion(), EXPECTED_LATEST);

  const applied = db.get().prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
  assert.equal(applied.n, EXPECTED_LATEST);

  db.closeConnection();
});

test.after(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(workDir, { recursive: true, force: true });
});
