/**
 * 测试：备份包组装与恢复前校验（server/services/backup-bundle.js /
 *       server/services/backup-verify.js）
 *
 * 覆盖：包格式识别、拆包（数据库 + 密钥文件）、缺库拒绝、密钥内容校验失败提示，
 *       以及"用包内密钥开包内数据库"的校验：明文库可开、加密库用对密钥可开、
 *       用错密钥被拒、非 Juju 库被拒。
 *
 * 说明：这两个模块都间接依赖 server/db.js（模块级 init），因此与迁移用例一样
 *       要求 Node >= 22；低版本 Node 上整组跳过并说明原因。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createZip } from '../server/utils/zip.js';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const DB_SKIP = NODE_MAJOR >= 22
  ? false
  : `better-sqlite3-multiple-ciphers 需要 Node >= 22（当前 v${process.versions.node}），跳过备份包用例`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'juju-bundle-test-'));
const savedEnv = { DB_PATH: process.env.DB_PATH, JUJU_SM4_KEY: process.env.JUJU_SM4_KEY, LOG_LEVEL: process.env.LOG_LEVEL };

process.env.DB_PATH = path.join(workDir, 'yuvomi.db');
process.env.JUJU_SM4_KEY = '0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL = 'error';

const SECRETS_CONTENT = [
  'DB_ENCRYPTION_KEY=00112233445566778899aabbccddeeff',
  'JUJU_SM4_KEY=0123456789abcdef0123456789abcdef',
  'SESSION_SECRET=deadbeefdeadbeefdeadbeefdeadbeef',
].join('\n');

/** 惰性加载模块（它们会连带初始化 db.js）。 */
function loadModules() {
  return Promise.all([
    import('../server/services/backup-bundle.js'),
    import('../server/services/backup-verify.js'),
    import('better-sqlite3-multiple-ciphers'),
  ]).then(([bundle, verify, sqlite]) => ({ bundle, verify, Database: sqlite.default }));
}

/**
 * 构造一个最小的 Juju 数据库文件（含 schema_migrations）。
 * @param {string} file 目标路径
 * @param {string|null} key 非空则按 SQLCipher 加密
 * @param {number} version schema 版本
 * @param {import('better-sqlite3-multiple-ciphers').Database} Database
 * @returns {string} 文件路径
 */
function makeJujuDatabase(file, key, version, Database) {
  const database = new Database(file);
  if (key) {
    database.pragma("cipher = 'sqlcipher'");
    database.pragma(`key="x'${Buffer.from(key, 'utf8').toString('hex')}'"`);
  }
  database.exec(`
    CREATE TABLE schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );
    INSERT INTO schema_migrations (version, description, applied_at) VALUES (${version}, 'seed', 'now');
  `);
  database.close();
  return file;
}

test('isBundle / parseBundle: 识别并拆出数据库与密钥文件', { skip: DB_SKIP }, async () => {
  const { bundle } = await loadModules();

  const archive = createZip([
    { name: 'juju.db', data: Buffer.from('DB-BYTES'), mode: 0o100644 },
    { name: '.juju-secrets', data: Buffer.from(SECRETS_CONTENT), mode: 0o100600 },
  ]);

  assert.equal(bundle.isBundle(archive), true);
  assert.equal(bundle.DB_ENTRY_NAME, 'juju.db');
  assert.equal(bundle.SECRETS_ENTRY_NAME, '.juju-secrets');

  const parsed = bundle.parseBundle(archive);
  assert.deepEqual(parsed.entries, ['juju.db', '.juju-secrets']);
  assert.equal(parsed.db.toString('utf8'), 'DB-BYTES');
  assert.equal(parsed.secrets.toString('utf8'), SECRETS_CONTENT);
  assert.equal(parsed.secretsError, null);
});

test('parseBundle: 缺 juju.db 时拒绝；密钥内容非法时给出原因', { skip: DB_SKIP }, async () => {
  const { bundle } = await loadModules();

  const withoutDb = createZip([{ name: 'readme.txt', data: Buffer.from('hi') }]);
  assert.throws(() => bundle.parseBundle(withoutDb), /not a Juju backup bundle/);

  const badSecrets = createZip([
    { name: 'juju.db', data: Buffer.from('DB-BYTES') },
    { name: '.juju-secrets', data: Buffer.from('DB_ENCRYPTION_KEY=only-one') },
  ]);
  const parsed = bundle.parseBundle(badSecrets);
  assert.equal(parsed.db.toString('utf8'), 'DB-BYTES');
  assert.match(parsed.secretsError, /missing/);
});

test('verifyBackupBundle: 明文库（无密钥）可校验通过', { skip: DB_SKIP }, async () => {
  const { verify, Database } = await loadModules();
  const dbPath = makeJujuDatabase(path.join(workDir, 'plain.db'), null, 152, Database);

  const result = await verify.verifyBackupBundle(dbPath, null);
  assert.equal(result.ok, true, `应通过校验：${result.reason}`);
  assert.equal(result.encrypted, false);
  assert.equal(result.schemaVersion, 152);
  assert.equal(result.encryptionKey, null);
});

test('verifyBackupBundle: 加密库 + 包内正确密钥 → 通过', { skip: DB_SKIP }, async () => {
  const { verify, Database } = await loadModules();
  const dbPath = makeJujuDatabase(path.join(workDir, 'enc.db'), '00112233445566778899aabbccddeeff', 152, Database);

  const result = await verify.verifyBackupBundle(dbPath, SECRETS_CONTENT);
  assert.equal(result.ok, true, `应通过校验：${result.reason}`);
  assert.equal(result.encrypted, true);
  assert.equal(result.schemaVersion, 152);
  assert.equal(result.encryptionKey, '00112233445566778899aabbccddeeff');
});

test('verifyBackupBundle: 密钥不匹配 → 明确拒绝（不破坏磁盘）', { skip: DB_SKIP }, async () => {
  const { verify, Database } = await loadModules();
  const dbPath = makeJujuDatabase(path.join(workDir, 'enc-wrong.db'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 152, Database);

  const wrongSecrets = SECRETS_CONTENT.replace('00112233445566778899aabbccddeeff', 'ffffffffffffffffffffffffffffffff');
  const result = await verify.verifyBackupBundle(dbPath, wrongSecrets);

  assert.equal(result.ok, false, '错误密钥必须被拒绝');
  assert.ok(result.reason, '必须给出可读的失败原因');
  assert.notEqual(result.schemaVersion, 152, '校验失败时不得报告有效版本号');
});

test('verifyBackupBundle: 非 Juju 数据库（无 schema_migrations）→ 拒绝', { skip: DB_SKIP }, async () => {
  const { verify, Database } = await loadModules();
  const file = path.join(workDir, 'foreign.db');
  const database = new Database(file);
  database.exec('CREATE TABLE something_else (id INTEGER)');
  database.close();

  const result = await verify.verifyBackupBundle(file, null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a valid Juju database|is not a database/);
});

test('verifyBackupDatabase: 文件不存在时给出明确原因', { skip: DB_SKIP }, async () => {
  const { verify } = await loadModules();
  const result = await verify.verifyBackupDatabase(path.join(workDir, 'missing.db'), null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not exist|No database path/);
});

test.after(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(workDir, { recursive: true, force: true });
});
