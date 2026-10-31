/**
 * 测试：联系人分类预设种子迁移（T2，v156）
 *
 * 覆盖：
 *   1) 全量迁移后的库中 contact_categories 含 6 个新预设（family/relatives/
 *      friends/work/school/services）+ 既有 misc（v84 遗留的 doctor 等
 *      同样保留——INSERT OR IGNORE 不清理历史行）。
 *   2) 预设行的 name 英文 fallback / label_key / icon / sort_order 正确。
 *   3) 幂等：同一份种子 SQL 重复执行不产生重复行。
 *   4) 不与用户自定义冲突：INSERT OR IGNORE 不会覆盖已存在 key 的自定义值。
 *
 * 用真实迁移链：DB_PATH 指向临时文件库，import server/db.js 即自动跑完
 * 156 条迁移（与生产路径一致，比内存库 + 手工建表更贴近真实）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'juju-category-seed-')), 'test.db');
process.env.LOG_LEVEL = 'error';

const db = await import('../server/db.js');
await db.init();

const NEW_PRESETS = [
  { key: 'family',    name: 'Family',    label_key: 'contacts.categoryFamily',    icon: 'users',     sort_order: 0 },
  { key: 'relatives', name: 'Relatives', label_key: 'contacts.categoryRelatives', icon: 'heart',     sort_order: 1 },
  { key: 'friends',   name: 'Friends',   label_key: 'contacts.categoryFriends',   icon: 'user',      sort_order: 2 },
  { key: 'work',      name: 'Work',      label_key: 'contacts.categoryWork',      icon: 'briefcase', sort_order: 3 },
  { key: 'services',  name: 'Services',  label_key: 'contacts.categoryServices',  icon: 'wrench',    sort_order: 5 },
];

/** v156 的种子 SQL（与 server/db.js 中逐字一致，用于幂等性复跑）。 */
const SEED_SQL = `
  INSERT OR IGNORE INTO contact_categories (key, name, label_key, icon, sort_order) VALUES
    ('family',    'Family',    'contacts.categoryFamily',    'users',          0),
    ('relatives', 'Relatives', 'contacts.categoryRelatives', 'heart',          1),
    ('friends',   'Friends',   'contacts.categoryFriends',   'user',           2),
    ('work',      'Work',      'contacts.categoryWork',      'briefcase',      3),
    ('school',    'School',    'contacts.categorySchool',    'graduation-cap', 4),
    ('services',  'Services',  'contacts.categoryServices',  'wrench',         5);
`;

test('迁移后 6 个新预设 + misc 全部在库（v84 遗留键不清理）', () => {
  const rows = db.get().prepare('SELECT key, name, label_key, icon, sort_order FROM contact_categories').all();
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

  for (const preset of NEW_PRESETS) {
    const row = byKey[preset.key];
    assert.ok(row, `预设 ${preset.key} 应存在`);
    assert.equal(row.name, preset.name);
    assert.equal(row.label_key, preset.label_key);
    assert.equal(row.icon, preset.icon);
    assert.equal(row.sort_order, preset.sort_order);
  }

  // school 在 v84 已存在（name NULL、sort_order 1）——v156 的 INSERT OR IGNORE
  // 不覆盖既有行，只保证 key 在库且 label_key 正确。
  assert.ok(byKey.school, '预设 school 应存在');
  assert.equal(byKey.school.label_key, 'contacts.categorySchool');
  assert.equal(byKey.school.icon, 'graduation-cap');

  // misc 保持 v84 原样（本迁移不触碰）。
  assert.ok(byKey.misc, 'misc 应保留');
  assert.equal(byKey.misc.label_key, 'contacts.categoryOther');
  // v84 遗留预设同样保留（INSERT OR IGNORE 语义：只增不改）。
  assert.ok(byKey.doctor, 'v84 的 doctor 应保留');
  // 数据库 schema 版本到位。
  assert.ok(db.currentVersion() >= 156, `schema 版本应 >= 156，实际 ${db.currentVersion()}`);
});

test('幂等：种子 SQL 复跑不产生重复行', () => {
  const before = db.get().prepare('SELECT COUNT(*) AS n FROM contact_categories').get().n;
  db.get().exec(SEED_SQL);
  const after = db.get().prepare('SELECT COUNT(*) AS n FROM contact_categories').get().n;
  assert.equal(after, before, 'INSERT OR IGNORE 复跑不得新增行');

  // 且行内容没有被改写。
  const family = db.get().prepare("SELECT name FROM contact_categories WHERE key = 'family'").get();
  assert.equal(family.name, 'Family');
});

test('不与用户自定义冲突：已有 key 的自定义值不被种子覆盖', () => {
  // 模拟用户改名：work → 自定义名。种子复跑后必须原样保留。
  db.get().prepare("UPDATE contact_categories SET name = '我的同事' WHERE key = 'work'").run();
  db.get().exec(SEED_SQL);

  const work = db.get().prepare("SELECT name, label_key FROM contact_categories WHERE key = 'work'").get();
  assert.equal(work.name, '我的同事', 'INSERT OR IGNORE 不得覆盖用户自定义');
  assert.equal(work.label_key, 'contacts.categoryWork');
});
