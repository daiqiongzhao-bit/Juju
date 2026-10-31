/**
 * 测试：导入执行器的农历派生（writeContact × applyLunarFields）
 *
 * 覆盖：
 *   1) 带 birthday 的联系人经 runImport 落库后，birthday_lunar / zodiac /
 *      constellation 非空，且与 lunar-fields 的 deriveLunarFields 输出一致。
 *   2) 生日年份越界（1900-2100 之外）→ 行照常导入，派生三字段为 NULL。
 *   3) dry_run：计数计入 created，但不写业务表。
 *
 * 复刻 media-emby.test.js 的注入方式：DB_PATH 指向临时库 + _setTestDatabase
 * 注入最小 schema 的内存库——不跑 156 条迁移，也不碰仓库里的真实库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 先于 import('../server/db.js') 设置：模块加载即初始化。
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'juju-import-lunar-')), 'test.db');
process.env.LOG_LEVEL = 'error';
// writeContact 对 phone 走 encryptField —— 需要 SM4 密钥（32 hex）。
process.env.JUJU_SM4_KEY = '0123456789abcdef0123456789abcdef';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const SKIP = NODE_MAJOR >= 22 ? false : `better-sqlite3-multiple-ciphers 需要 Node >= 22（当前 v${process.versions.node}）`;

let runImport = null;
let db = null;
let testDb = null;

async function setup() {
  if (runImport) return;
  const [{ _setTestDatabase }, DatabaseMod, runnerMod, lunarMod] = await Promise.all([
    import('../server/db.js'),
    import('better-sqlite3-multiple-ciphers'),
    import('../server/services/import-runner.js'),
    import('../server/services/lunar-fields.js'),
  ]);
  const Database = DatabaseMod.default;
  testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE contacts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      category       TEXT,
      email          TEXT,
      notes          TEXT,
      birthday       TEXT,
      birthday_lunar TEXT,
      zodiac         TEXT,
      constellation  TEXT,
      phone          TEXT,
      phone_hash     TEXT,
      address        TEXT,
      organization   TEXT,
      job_title      TEXT,
      nickname       TEXT
    );
    CREATE TABLE import_batches (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      module       TEXT NOT NULL,
      file_name    TEXT,
      dry_run      INTEGER NOT NULL DEFAULT 0,
      rows_total   INTEGER NOT NULL DEFAULT 0,
      created_rows INTEGER NOT NULL DEFAULT 0,
      skipped_rows INTEGER NOT NULL DEFAULT 0,
      failed_rows  INTEGER NOT NULL DEFAULT 0,
      created_by   INTEGER,
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE import_row_map (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      module       TEXT NOT NULL,
      fingerprint  TEXT NOT NULL,
      entity_table TEXT NOT NULL,
      entity_id    INTEGER NOT NULL,
      batch_id     INTEGER,
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE UNIQUE INDEX idx_import_row_map_unique ON import_row_map(module, fingerprint);
  `);
  _setTestDatabase(testDb);
  runImport = runnerMod.runImport;
  db = lunarMod; // deriveLunarFields 用于一致性对照
}

test('带 birthday 的记录落库后派生三字段非空且与 lunar-fields 一致', async () => {
  if (SKIP) return test.skip(SKIP);
  await setup();

  const report = runImport({
    moduleKey: 'contacts',
    records: [{
      rowNumber: 2,
      record: { name: '张三', category: 'family', birthday: '1990-05-09', phone: '+86 138 0013 8000' },
      errors: [],
    }],
  });

  assert.equal(report.created, 1, '应创建 1 行');
  assert.equal(report.failed, 0);
  assert.deepEqual(report.failures, []);

  const row = testDb.prepare('SELECT * FROM contacts WHERE name = ?').get('张三');
  assert.ok(row, '联系人应已落库');
  assert.equal(row.birthday, '1990-05-09');
  assert.ok(row.birthday_lunar, 'birthday_lunar 应非空');
  assert.ok(row.zodiac, 'zodiac 应非空');
  assert.ok(row.constellation, 'constellation 应非空');

  // 与 lunar-fields 的独立换算结果逐字段一致（单一数据源：applyLunarFields）。
  const expected = db.deriveLunarFields('1990-05-09');
  assert.equal(row.birthday_lunar, expected.birthdayLunar);
  assert.equal(row.zodiac, expected.zodiac);
  assert.equal(row.constellation, expected.constellation);
});

test('生日年份越界（1889）→ 行照常导入，派生三字段为 NULL', async () => {
  if (SKIP) return test.skip(SKIP);
  await setup();

  const report = runImport({
    moduleKey: 'contacts',
    records: [{
      rowNumber: 2,
      record: { name: '李四', birthday: '1889-06-01' },
      errors: [],
    }],
  });

  assert.equal(report.created, 1, '越界生日不阻塞导入');
  const row = testDb.prepare('SELECT * FROM contacts WHERE name = ?').get('李四');
  assert.ok(row);
  assert.equal(row.birthday, '1889-06-01');
  assert.equal(row.birthday_lunar, null);
  assert.equal(row.zodiac, null);
  assert.equal(row.constellation, null);
});

test('dry_run：计数 created 但不写业务表', async () => {
  if (SKIP) return test.skip(SKIP);
  await setup();

  const before = testDb.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  const report = runImport({
    moduleKey: 'contacts',
    dryRun: true,
    records: [{ rowNumber: 2, record: { name: '王五', birthday: '2000-02-29' }, errors: [] }],
  });

  assert.equal(report.dryRun, true);
  assert.equal(report.created, 1);
  const after = testDb.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  assert.equal(after, before, 'dry_run 不得写业务表');
});
