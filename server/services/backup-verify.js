/**
 * 模块：备份包可用性校验（独立子进程）
 * 目的：在恢复流程触碰磁盘上任何东西之前,必须先"证明能开"——备份包里的
 *       数据库用备份包里的密钥确实能被打开且结构有效。
 *
 * 为什么必须开子进程（而不是在主进程里调一个函数）：
 *   server/db.js 在模块加载时就把密钥读进了模块变量 DB_KEY。之后无论怎么改
 *   process.env,它都拿不到新值——所以"先把密钥写进 process.env 再校验"在主
 *   进程里等于用**旧密钥**校验,完全没有意义(这正是上一版恢复失败的根因)。
 *   子进程启动时重新读取 process.env,它看到的必然是备份包里的密钥。
 *
 * 本文件同时是 CLI 和库：
 *   - CLI： node server/services/backup-verify.js <数据库路径>
 *           （密钥经环境变量 DB_ENCRYPTION_KEY 注入）
 *   - 库：   verifyBackupBundle(dbPath, secretsContent) 会派生自己为子进程
 *           并解析其 stdout 的 JSON 结果。
 *
 * 依赖：better-sqlite3-multiple-ciphers（项目既有依赖）、node:fs / node:path /
 *       node:child_process / node:url
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { spawn } from 'node:child_process';
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSecrets } from './backup-secrets.js';

/** 未加密 SQLite 文件的文件头（与 server/db.js 保持一致）。 */
const SQLITE_PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'binary');

/** 校验不能无限挂起：超时后杀掉子进程。 */
const VERIFY_TIMEOUT_MS = 120000;

/** 兜底：异常巨大的包直接拒绝，避免校验进程被拖死。 */
const MAX_DB_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * 读取文件头部,判断是否为未加密的 SQLite 文件。
 * 加密前的老备份是明文存放的,这类文件**不能**带 key 打开,否则 SQLite 会报
 * "file is not a database"。
 *
 * @param {string} filePath
 * @returns {boolean} true = 明文 SQLite
 */
function isPlaintextDatabase(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const head = Buffer.alloc(SQLITE_PLAINTEXT_HEADER.length);
    const bytesRead = readSync(fd, head, 0, head.length, 0);
    return bytesRead === head.length && head.equals(SQLITE_PLAINTEXT_HEADER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 文件反正是要关的 */ }
    }
  }
}

/**
 * 用给定密钥打开数据库并校验结构 + 完整性。任何问题都以可理解的理由抛出。
 *
 * @param {string} dbPath 解压出来的数据库文件路径
 * @param {string} encryptionKey DB_ENCRYPTION_KEY（空串 = 明文库）
 * @returns {{ schemaVersion: number, encrypted: boolean }}
 * @throws {Error} 密钥不匹配 / 文件损坏 / 不是 Juju 数据库
 */
function openAndCheck(dbPath, encryptionKey) {
  const encrypted = !isPlaintextDatabase(dbPath);

  if (encrypted && !encryptionKey) {
    throw new Error('The backup database is encrypted, but no DB_ENCRYPTION_KEY was supplied.');
  }

  const database = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (encrypted) {
      // 顺序是强制的：cipher 必须早于 key（SQLCipher / AES-256）。
      database.pragma("cipher = 'sqlcipher'");
      database.pragma(`key="x'${Buffer.from(encryptionKey, 'utf8').toString('hex')}'"`);
    }

    // 第一次真正的查询：密钥对不对,就是在这里暴露（"file is not a database"）。
    database.prepare('SELECT count(*) FROM sqlite_master').get();

    const integrity = database.pragma('quick_check');
    const integrityRow = Array.isArray(integrity) ? integrity[0] : null;
    const integrityValue = integrityRow ? String(Object.values(integrityRow)[0] ?? '') : '';
    if (integrityRow && integrityValue.toLowerCase() !== 'ok') {
      throw new Error(`The backup database failed its integrity check: ${integrityValue}`);
    }

    const schemaRow = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (!schemaRow) {
      throw new Error('The backup file is not a valid Juju database (schema_migrations is missing).');
    }

    const versionRow = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
    return { schemaVersion: Number(versionRow?.version ?? 0), encrypted };
  } finally {
    try { database.close(); } catch { /* best effort */ }
  }
}

// --------------------------------------------------------
// CLI 部分
// --------------------------------------------------------

/**
 * 执行校验并把结果以 JSON 写到 stdout；退出码才是真正的信号（0 = 可恢复）。
 * @returns {never}
 */
function runCli() {
  const dbPath = process.argv[2];
  if (!dbPath) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'No database path given.' }));
    process.exit(2);
  }
  if (!existsSync(dbPath)) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'The backup database file does not exist.' }));
    process.exit(1);
  }
  try {
    if (statSync(dbPath).size > MAX_DB_BYTES) {
      throw new Error('The backup database is implausibly large.');
    }
    const result = openAndCheck(dbPath, process.env.DB_ENCRYPTION_KEY || '');
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
    process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, reason: err?.message || String(err) }));
    process.exit(1);
  }
}

// --------------------------------------------------------
// 库部分：派生子进程并解析结果
// --------------------------------------------------------

/**
 * 构造校验子进程的环境变量。
 *
 * 这里刻意覆盖/删除 DB_ENCRYPTION_KEY 并移除 DB_PATH：校验进程绝不允许碰到
 * 正在运行的数据库,它只能看解压出来的那一份。
 *
 * @param {string|null} encryptionKey 备份包里的密钥（null = 删除该变量）
 * @returns {NodeJS.ProcessEnv}
 */
function buildChildEnv(encryptionKey) {
  const env = { ...process.env };
  delete env.DB_PATH;             // 校验进程里不存在"线上库"
  delete env.DB_ENCRYPTION_KEY;
  if (encryptionKey) env.DB_ENCRYPTION_KEY = encryptionKey;
  return env;
}

/**
 * 完整读取一个流,最多 limit 个字符。
 * @param {import('node:stream').Readable} stream
 * @param {number} limit
 * @returns {Promise<string>}
 */
function readStream(stream, limit = 65536) {
  return new Promise((resolve) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      if (data.length < limit) data += chunk;
    });
    stream.on('end', () => resolve(data));
    stream.on('error', () => resolve(data));
  });
}

/**
 * 在一个全新的 node 子进程里校验备份数据库。
 *
 * @param {string} dbPath 解压出来的数据库文件（临时文件）
 * @param {string|null} encryptionKey 用于打开的 DB_ENCRYPTION_KEY；
 *        null 或空串表示按明文库处理。
 * @returns {Promise<{ ok: boolean, schemaVersion: number, encrypted: boolean, reason: string|null }>}
 */
export function verifyBackupDatabase(dbPath, encryptionKey) {
  const scriptPath = fileURLToPath(import.meta.url);
  const absoluteDbPath = path.resolve(dbPath);
  const env = buildChildEnv(encryptionKey || null);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [scriptPath, absoluteDbPath], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: VERIFY_TIMEOUT_MS,
      });
    } catch (err) {
      resolve({ ok: false, schemaVersion: 0, encrypted: false, reason: err?.message || String(err) });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const stdoutPromise = readStream(child.stdout);
    const stderrPromise = readStream(child.stderr);

    child.on('error', (err) => {
      finish({
        ok: false,
        schemaVersion: 0,
        encrypted: false,
        reason: `Verification process failed to start: ${err?.message || err}`,
      });
    });

    child.on('close', async (code, signal) => {
      const stdout = (await stdoutPromise).trim();
      const stderr = (await stderrPromise).trim();

      let parsed = null;
      if (stdout) {
        try { parsed = JSON.parse(stdout); } catch { parsed = null; }
      }

      if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
        finish({
          ok: parsed.ok === true,
          schemaVersion: Number(parsed.schemaVersion ?? 0),
          encrypted: parsed.encrypted === true,
          reason: parsed.reason ?? null,
        });
        return;
      }

      if (signal === 'SIGTERM') {
        finish({ ok: false, schemaVersion: 0, encrypted: false, reason: 'The backup verification timed out.' });
        return;
      }

      finish({
        ok: false,
        schemaVersion: 0,
        encrypted: false,
        reason: stderr || `The backup verification process exited unexpectedly (code ${code}).`,
      });
    });
  });
}

/**
 * 一次把"数据库 + 密钥文件"这对组合验完：用包内密钥去开包内数据库。
 *
 * @param {string} dbPath 解压出来的数据库文件
 * @param {Buffer|string|null} secretsContent 包内密钥文件内容
 * @returns {Promise<{ ok: boolean, schemaVersion: number, encrypted: boolean, reason: string|null, encryptionKey: string|null }>}
 */
export async function verifyBackupBundle(dbPath, secretsContent) {
  const values = secretsContent ? parseSecrets(secretsContent) : {};
  const encryptionKey = values.DB_ENCRYPTION_KEY || null;
  const result = await verifyBackupDatabase(dbPath, encryptionKey);
  return { ...result, encryptionKey };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) runCli();

export default { verifyBackupDatabase, verifyBackupBundle };
