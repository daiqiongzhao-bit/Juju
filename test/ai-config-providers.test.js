/**
 * 测试：AI 供应商预置配置（R1，server/services/ai-config.js）
 *
 * 覆盖：AI_PROVIDERS 11 项完整性（key/label/baseUrl/models 形状、可选
 *       keyUrl/hintKey/modelHintKey 类型）、custom 保持末位、
 *       providerByKey 未知 key 回落末项、掩码不泄漏明文、
 *       getPublicConfig 对外视图无明文 key、sanitizeBaseUrl 归一化。
 *
 * 说明：ai-config.js 传递依赖 server/db.js（模块级 init +
 *       better-sqlite3-multiple-ciphers 13.x 要求 Node >= 22），与迁移/
 *       备份/天气用例同一约定：低版本整组跳过并说明原因。数据库侧用
 *       _setTestDatabase 注入最小内存库（ai_config + users 两表），
 *       不跑 155 条迁移，也不碰仓库里的真实库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const DB_SKIP = NODE_MAJOR >= 22
  ? false
  : `better-sqlite3-multiple-ciphers 需要 Node >= 22（当前 v${process.versions.node}），跳过 AI 配置用例`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'juju-ai-config-test-'));

// 先于 import('../server/db.js')（ai-config.js 的传递依赖）设置：模块加载
// 即初始化。JUJU_SM4_KEY 供 encryptField 使用（32 字节十六进制）。
process.env.DB_PATH = path.join(workDir, 'yuvomi.db');
process.env.JUJU_SM4_KEY = '0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL = 'error';

/** PRD §6 全量清单：10 个具名供应商 + Custom（custom 必须末位）。 */
const EXPECTED_KEYS = [
  'openai', 'deepseek', 'qwen', 'zhipu', 'moonshot', 'doubao',
  'minimax', 'qianfan', 'hunyuan', 'siliconflow', 'custom',
];

/** 最小 schema：ai_config（v153 形状）+ users（updated_by 外键 + 显示名）。 */
function seedDatabase(Database) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_config (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      provider   TEXT    NOT NULL DEFAULT 'custom',
      base_url   TEXT,
      api_key    TEXT,
      model      TEXT,
      enabled    INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT);
    INSERT INTO ai_config (id, provider, enabled) VALUES (1, 'openai', 0);
    INSERT INTO users (id, username, display_name) VALUES (1, 'admin', '管理员');
  `);
  return db;
}

/**
 * 导入 ai-config 模块并注入测试库。
 * @returns {Promise<{mod: object, db: object}>}
 */
async function loadModule() {
  const [mod, dbMod, DatabaseMod] = await Promise.all([
    import('../server/services/ai-config.js'),
    import('../server/db.js'),
    import('better-sqlite3-multiple-ciphers'),
  ]);
  dbMod._setTestDatabase(seedDatabase(DatabaseMod.default));
  return { mod, db: dbMod };
}

test('AI_PROVIDERS：11 项完整、形状合法、custom 末位、列表冻结', { skip: DB_SKIP }, async () => {
  const { mod } = await loadModule();
  const list = mod.AI_PROVIDERS;

  assert.equal(list.length, 11);
  assert.deepEqual(list.map((p) => p.key), EXPECTED_KEYS);
  // custom 末位是 providerByKey 回落逻辑的前提
  assert.equal(list[list.length - 1].key, 'custom');

  for (const p of list) {
    assert.equal(typeof p.key, 'string', `${p.key}: key 必须是字符串`);
    assert.ok(p.key.length > 0, 'key 不能为空');
    assert.equal(typeof p.label, 'string', `${p.key}: label 必须是字符串`);
    assert.ok(p.label.length > 0, `${p.key}: label 不能为空`);
    assert.equal(typeof p.baseUrl, 'string', `${p.key}: baseUrl 必须是字符串`);
    assert.ok(Array.isArray(p.models), `${p.key}: models 必须是数组`);
    for (const m of p.models) assert.equal(typeof m, 'string');
    // 可选字段一旦出现就必须是非空字符串
    for (const field of ['keyUrl', 'hintKey', 'modelHintKey']) {
      if (p[field] !== undefined) {
        assert.equal(typeof p[field], 'string', `${p.key}.${field} 必须是字符串`);
        assert.ok(p[field].length > 0, `${p.key}.${field} 不能为空`);
      }
    }
    if (p.key !== 'custom') {
      assert.ok(/^https?:\/\//.test(p.baseUrl), `${p.key}: 预设 Base URL 必须是 http(s)`);
    }
  }

  // 冻结：防止运行时误改共享数据（定制方舟这类无模型名的条目 models 为空数组）
  assert.ok(Object.isFrozen(list));
  assert.deepEqual(mod.AI_PROVIDERS.find((p) => p.key === 'doubao').models, []);
  assert.equal(mod.AI_PROVIDERS.find((p) => p.key === 'doubao').modelHintKey, 'doubao');
});

test('providerByKey：已知命中、未知/null/空白一律回落 custom', { skip: DB_SKIP }, async () => {
  const { mod } = await loadModule();
  const last = mod.AI_PROVIDERS[mod.AI_PROVIDERS.length - 1];

  assert.equal(mod.providerByKey('deepseek').key, 'deepseek');
  assert.equal(mod.providerByKey(' deepseek ').key, 'deepseek'); // 去空白后命中
  assert.equal(mod.providerByKey('private-gateway'), last); // 未知 → 末项
  assert.equal(mod.providerByKey(null), last);
  assert.equal(mod.providerByKey(undefined), last);
  assert.equal(mod.providerByKey(''), last);
});

test('maskKey：只露后四位，明文主体不出现', { skip: DB_SKIP }, async () => {
  const { mod } = await loadModule();
  const plain = 'sk-super-secret-tail42';

  const masked = mod.maskKey(plain);
  assert.ok(masked.endsWith('il42'), '后四位可见');
  assert.ok(!masked.includes('super'), '中段不得出现');
  assert.ok(!masked.includes('sk-'), '前缀不得出现');
  assert.ok(masked.length <= 17, '掩码长度有界，不长出血');

  assert.equal(mod.maskKey(''), '');
  assert.equal(mod.maskKey(null), '');
  assert.equal(mod.maskKey('abcd'), '••••'); // 太短整体打码
  assert.equal(mod.maskKey(undefined), ''); // 无值可掩 → 空串（调用方按 keySet 决定是否展示）
});

test('getPublicConfig： providers 透传 11 项；未配 key 时无掩码无明文', { skip: DB_SKIP }, async () => {
  const { mod } = await loadModule();
  const pub = mod.getPublicConfig();

  assert.equal(pub.providers.length, 11);
  assert.equal(pub.provider, 'openai');
  assert.equal(pub.keySet, false);
  assert.equal(pub.maskedKey, '');
  // 对外视图根本不应该带 apiKey 字段
  assert.ok(!('apiKey' in pub), '对外视图不得包含 apiKey 字段');
  assert.ok(!JSON.stringify(pub).includes('sk-'), '序列化后无任何 key 痕迹');
});

test('saveConfig：SM4 落库 + 对外仅掩码；未知 provider 降级 custom', { skip: DB_SKIP }, async () => {
  const { mod, db } = await loadModule();
  const secret = 'sk-test-abcdef1234';

  const saved = mod.saveConfig(
    { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/', model: 'deepseek-chat', apiKey: secret, enabled: true },
    1,
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.data.provider, 'deepseek');
  assert.equal(saved.data.baseUrl, 'https://api.deepseek.com/v1'); // 尾斜杠归一
  assert.equal(saved.data.keySet, true);
  assert.ok(saved.data.maskedKey.endsWith('1234'));
  assert.ok(!JSON.stringify(saved.data).includes(secret), '保存响应不得泄漏明文 key');

  // 数据库里存的是密文，不是明文（用同一个注入库，不能重新 seed）
  const row = db.get().prepare('SELECT api_key FROM ai_config WHERE id = 1').get();
  assert.ok(row.api_key, '密文已落库');
  assert.notEqual(row.api_key, secret, '落库的不是明文');
  assert.ok(!row.api_key.includes(secret), '密文中不含明文字段');

  // 重新读取：明文只在服务端内部（getConfig），对外仍掩码
  const pub = mod.getPublicConfig();
  assert.equal(pub.keySet, true);
  assert.ok(!JSON.stringify(pub).includes(secret));
  assert.equal(mod.getConfig().apiKey, secret);

  // 未知 provider：保存时降级为 custom，不静默改写
  const weird = mod.saveConfig({ provider: 'my-gateway' }, 1);
  assert.equal(weird.data.provider, 'custom');

  // clearKey：清空后 keySet=false
  const cleared = mod.saveConfig({ clearKey: true }, 1);
  assert.equal(cleared.data.keySet, false);
  assert.equal(cleared.data.maskedKey, '');
  assert.equal(mod.getConfig().apiKey, null);
});

test('sanitizeBaseUrl：去尾斜杠、只认 http(s)，非法值回落空串', { skip: DB_SKIP }, async () => {
  const { mod } = await loadModule();
  assert.equal(mod.sanitizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.equal(mod.sanitizeBaseUrl('  https://x.dev/v1//  '), 'https://x.dev/v1');
  assert.equal(mod.sanitizeBaseUrl('ftp://x.dev'), '');
  assert.equal(mod.sanitizeBaseUrl('not a url'), '');
  assert.equal(mod.sanitizeBaseUrl(''), '');
  assert.equal(mod.sanitizeBaseUrl(null), '');
});
