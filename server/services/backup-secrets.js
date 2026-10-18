/**
 * Modul: Schlüsseldatei im Sicherungskreislauf (Backup Secrets)
 * Zweck: Seit 0.0.28 liegen DB_ENCRYPTION_KEY, JUJU_SM4_KEY und SESSION_SECRET
 *        in einer Datei im Daten-Verzeichnis (`/data/.juju-secrets`, 0600).
 *        **Ohne diese Datei ist die verschlüsselte Datenbank dauerhaft
 *        unlesbar** — ein Datenbank-Backup allein ist also wertlos, wenn der
 *        Container neu aufgesetzt wird.
 *
 *        Dieses Modul hält die Datei instand: einlesen fürs Backup, validieren
 *        und atomar zurückschreiben beim Restore.
 *
 * Sicherheitsregeln:
 *   - Die Datei verlässt den Server nur INNERHALB des verschlüsselten
 *     Sicherungspakets; im Paket trägt sie Modus 0600.
 *   - Beim Zurückschreiben wird die bestehende Datei zuerst als
 *     `.pre-restore-<Zeitstempel>` gesichert und die neue atomar (tmp + rename)
 *     mit 0600 geschrieben — bricht der Vorgang ab, bleibt die alte Datei gültig.
 *   - Inhalt wird geprüft, bevor er geschrieben wird: nur `KEY=WERT`-Zeilen,
 *     alle drei Schlüssel vorhanden, keine Binärdaten.
 *
 * Restore-Reihenfolge（见 server/routes/backup.js，勿再打乱）:
 *   1. 密钥先落到临时文件（stageSecretsFile，0600），/data/.juju-secrets 不动
 *   2. 子进程校验"包内密钥能开包内数据库"
 *   3. 校验通过才原子替换密钥文件 → 再替换数据库
 *   4. 任一步失败 → rollbackSecretsFile + restoreEnvSnapshot 完整回滚
 *
 * Abhängigkeiten: node:fs/promises, node:path, node:os
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createLogger } from '../logger.js';

const log = createLogger('BackupSecrets');

/** Name der Schlüsseldatei innerhalb des Sicherungspakets. */
export const SECRETS_ENTRY_NAME = '.juju-secrets';

/** Schlüssel, die in einer gültigen Datei vorhanden sein müssen. */
export const REQUIRED_KEYS = ['DB_ENCRYPTION_KEY', 'JUJU_SM4_KEY', 'SESSION_SECRET'];

/** Maximalgrösse der Schlüsseldatei — sie enthält nur drei Hex-Zeilen. */
const MAX_SECRETS_BYTES = 64 * 1024;

/**
 * Pfad der Schlüsseldatei. `JUJU_SECRETS_FILE` überschreibt den Default und
 * deckt sich damit mit entrypoint.sh — so zeigt Backup und Laufzeitumgebung
 * garantiert auf dieselbe Datei.
 * @returns {string}
 */
export function secretsPath() {
  return process.env.JUJU_SECRETS_FILE || '/data/.juju-secrets';
}

/**
 * Prüft, ob die Schlüsseldatei existiert und lesbar ist.
 * @returns {Promise<boolean>}
 */
export async function secretsAvailable() {
  try {
    await fs.access(secretsPath(), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Liest die Schlüsseldatei als Puffer (leerer Puffer, wenn sie fehlt).
 * @returns {Promise<Buffer>}
 */
export async function readSecretsBuffer() {
  try {
    return await fs.readFile(secretsPath());
  } catch (err) {
    if (err?.code === 'ENOENT') return Buffer.alloc(0);
    throw err;
  }
}

/**
 * Validiert den Inhalt einer Schlüsseldatei, bevor er zurückgeschrieben wird.
 *
 * Geprüft wird absichtlich streng: die Datei ersetzt beim Restore die
 * kryptographische Identität der Installation. Eine Zeile zu viel oder ein
 * binäres Artefakt macht das System unstartbar — also lieber ablehnen.
 *
 * @param {Buffer|string} content
 * @returns {{ ok: boolean, keys: string[], error: string|null }}
 */
export function validateSecretsContent(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content ?? '');

  if (!text.trim()) return { ok: false, keys: [], error: 'The secrets file is empty.' };
  if (Buffer.byteLength(text, 'utf8') > MAX_SECRETS_BYTES) {
    return { ok: false, keys: [], error: 'The secrets file is implausibly large.' };
  }
  if (/[\u0000-\u0008\u000b-\u001f]/.test(text)) {
    return { ok: false, keys: [], error: 'The secrets file contains control characters.' };
  }

  const found = new Set();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      return { ok: false, keys: [...found], error: `Malformed line in secrets file: "${trimmed.slice(0, 40)}"` };
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      return { ok: false, keys: [...found], error: `Invalid key name in secrets file: "${key}"` };
    }
    if (!value) {
      return { ok: false, keys: [...found], error: `Empty value for ${key} in secrets file.` };
    }
    found.add(key);
  }

  const missing = REQUIRED_KEYS.filter((key) => !found.has(key));
  if (missing.length > 0) {
    return { ok: false, keys: [...found], error: `Secrets file is missing: ${missing.join(', ')}.` };
  }
  return { ok: true, keys: [...found], error: null };
}

/**
 * Parst eine Schlüsseldatei in ein KEY→WERT-Objekt (Kommentare werden ignoriert).
 * @param {Buffer|string} content
 * @returns {Record<string, string>}
 */
export function parseSecrets(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content ?? '');
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    result[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return result;
}

/**
 * 把内容原子地写到目标路径（同目录 tmp + rename，模式 0600）。
 * 任何时刻磁盘上都只有"旧文件"或"完整的新文件"，不存在半截状态。
 *
 * @param {string} target 目标路径
 * @param {Buffer} payload 已校验的内容
 * @returns {Promise<void>}
 */
async function writeAtomic(target, payload) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmpPath = path.join(path.dirname(target), `.juju-secrets.tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmpPath, payload, { mode: 0o600 });
    await fs.chmod(tmpPath, 0o600);
    await fs.rename(tmpPath, target);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * 把备份包里的密钥内容**暂存**到临时文件（0600）。
 *
 * 这是恢复流程的第一步：先落到一个与 /data/.juju-secrets 完全无关的地方，
 * 供子进程校验使用。真正的密钥文件要等"校验通过"才允许被覆盖——否则一旦
 * 数据库恢复失败，磁盘上就会留下「新密钥 + 用旧密钥加密的旧库」的错配状态，
 * 容器再也起不来。
 *
 * @param {Buffer|string} content 密钥文件内容
 * @param {string} [directory] 临时目录（缺省用系统临时目录）
 * @returns {Promise<string>} 临时文件路径
 */
export async function stageSecretsFile(content, directory = null) {
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const baseDir = directory || os.tmpdir();
  await fs.mkdir(baseDir, { recursive: true });
  const target = path.join(baseDir, `.juju-secrets.staged-${process.pid}-${Date.now()}`);
  await fs.writeFile(target, payload, { mode: 0o600 });
  await fs.chmod(target, 0o600);
  return target;
}

/**
 * Schreibt die Schlüsseldatei atomar zurück und legt vorher eine Sicherung der
 * bestehenden Datei an.
 *
 * @param {Buffer|string} content Validierter Inhalt
 * @returns {Promise<{ path: string, previousBackup: string|null }>}
 */
export async function restoreSecretsFile(content) {
  const target = secretsPath();
  const check = validateSecretsContent(content);
  if (!check.ok) throw new Error(`Secrets file rejected: ${check.error}`);

  const payload = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');

  await fs.mkdir(path.dirname(target), { recursive: true });

  // ① Bestehende Datei sichern (wie beim DB-Restore: `.pre-restore-<Zeit>`).
  let previousBackup = null;
  try {
    await fs.access(target);
    previousBackup = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.copyFile(target, previousBackup);
    await fs.chmod(previousBackup, 0o600);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    previousBackup = null;
  }

  // ② Atomar schreiben: tmp im gleichen Verzeichnis + rename, damit kein
  //    Halb-Datei-Zustand übrig bleibt, wenn der Prozess hier stirbt.
  await writeAtomic(target, payload);

  log.info(`Secrets file restored${previousBackup ? ` | previous: ${path.basename(previousBackup)}` : ''}`);
  return { path: target, previousBackup };
}

/**
 * 把密钥文件回滚到恢复之前的内容。
 *
 * 只在"校验通过 → 已覆盖密钥文件 → 后续步骤失败"时调用。必须与数据库回滚
 * 成对出现：磁盘上留下的必须是**同一套**密钥与数据库，否则实例永久变砖。
 *
 * @param {Buffer|null} previousContent 恢复前的原文件；null = 原来不存在，删掉
 * @returns {Promise<void>}
 */
export async function rollbackSecretsFile(previousContent) {
  const target = secretsPath();
  if (!previousContent || previousContent.length === 0) {
    await fs.rm(target, { force: true });
    log.warn('Secrets rollback: restored file removed (none existed before the restore).');
    return;
  }
  await writeAtomic(target, previousContent);
  log.warn('Secrets rollback: previous secrets file restored.');
}

/**
 * 记录当前 process.env 中三个关键密钥的值，供失败回滚使用。
 * 值为 undefined 表示该变量原本不存在（回滚时要删除，而不是设成空串）。
 *
 * @returns {Record<string, string|undefined>}
 */
export function snapshotEnv() {
  const snapshot = {};
  for (const key of REQUIRED_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

/**
 * 把 process.env 的密钥恢复成快照里的值。
 *
 * @param {Record<string, string|undefined>} snapshot snapshotEnv() 的返回值
 * @returns {string[]} 被写回的键名
 */
export function restoreEnvSnapshot(snapshot) {
  const restored = [];
  for (const key of REQUIRED_KEYS) {
    const value = snapshot?.[key];
    if (value === undefined) {
      delete process.env[key];
      restored.push(key);
    } else if (process.env[key] !== value) {
      process.env[key] = value;
      restored.push(key);
    }
  }
  if (restored.length > 0) log.warn(`Runtime env rolled back: ${restored.join(', ')}`);
  return restored;
}

/**
 * Übernimmt die Schlüssel einer (frisch restaurierten) Datei in `process.env`.
 *
 * WICHTIG（上一版致命缺陷的根因）: diese Funktion wirkt AUSSCHLIESSLICH auf
 * `process.env`. Module, die ihren Schlüssel beim Laden in eine Variable
 * kopiert haben — namentlich `server/db.js` mit `DB_KEY` — sehen den neuen Wert
 * dadurch NICHT. Der Datenbank-Key muss deshalb zusätzlich über
 * `db.restoreFromFile(..., { encryptionKey })` gesetzt werden. Was hier allein
 * greift, sind die Schlüssel, die bei jedem Aufruf neu aus der Umwelt gelesen
 * werden (z. B. JUJU_SM4_KEY in server/services/sm4.js).
 *
 * Aufrufreihenfolge im Restore: Schlüsseldatei schreiben → HIER die Umwelt
 * aktualisieren → Datenbank einspielen. Erst danach stimmen Umgebung und Datei
 * wieder überein.
 *
 * @param {Buffer|string} content
 * @returns {string[]} Namen der gesetzten Schlüssel
 */
export function applySecretsToEnv(content) {
  const values = parseSecrets(content);
  const applied = [];
  for (const key of REQUIRED_KEYS) {
    if (values[key]) {
      process.env[key] = values[key];
      applied.push(key);
    }
  }
  if (applied.length > 0) log.info(`Applied restored secrets to runtime env: ${applied.join(', ')}`);
  return applied;
}

/**
 * Liefert Statusdaten für die Backup-Oberfläche. Der Pfad wird bewusst
 * MITgeschickt (der Admin sieht ihn sowieso in der Compose-Datei), der Inhalt
 * natürlich nicht.
 * @returns {Promise<{ path: string, available: boolean, keys: string[] }>}
 */
export async function getSecretsStatus() {
  const target = secretsPath();
  const available = await secretsAvailable();
  let keys = [];
  if (available) {
    try {
      const content = await readSecretsBuffer();
      keys = Object.keys(parseSecrets(content));
    } catch {
      keys = [];
    }
  }
  return { path: target, available, keys };
}
