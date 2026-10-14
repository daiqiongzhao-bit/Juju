/**
 * Modul: SM4 Field Encryption (R3/R4 - rnw 补差)
 * Zweck: 敏感联系人字段（phone/address/vehicle_plate/street）的应用层加密。
 *
 * 约定（C6）：
 *   - 算法 SM4-CBC（国密），密钥取 process.env.JUJU_SM4_KEY（32 hex = 16 字节，
 *     启动守卫 sm4-key-guard.js 保证存在且合法）。
 *   - 密文格式 `v1.<base64(iv)>.<base64(ciphertext)>`，每次加密随机生成 IV，
 *     故同一明文两次加密结果不同（防频率分析/等值比对）。
 *   - `v1.` 前缀即密文判定（isCipher），旧明文数据无双轨过渡期障碍：
 *     读路径 decryptField 对非 `v1.` 值原样返回并告警，不抛错。
 *
 * Abhängigkeiten: sm-crypto（纯 JS，已随 T01 依赖声明）、node:crypto（IV/HMAC）
 */

import crypto from 'node:crypto';
// sm-crypto 为 CJS-only 包（无 ESM 构建），ESM 侧须走默认导入解构。
import smCrypto from 'sm-crypto';

const { sm4 } = smCrypto;

/** 密文版本前缀（约定 C6）。 */
const CIPHER_PREFIX = 'v1.';

/** SM4 分组长度（字节）——CBC IV 长度。 */
const IV_BYTES = 16;

/** JUJU_SM4_KEY 合法格式：32 hex chars（= 16 字节密钥）。 */
const KEY_HEX_PATTERN = /^[0-9a-fA-F]{32}$/;

/**
 * Lädt den SM4-Schlüssel aus JUJU_SM4_KEY.
 * 每次调用读取环境变量（不做模块级缓存），避免测试/热更新场景下的陈旧副本。
 * @returns {string} 32 hex chars (16 bytes)
 * @throws {Error} 缺钥或格式非法时抛出明确错误
 */
export function loadKey() {
  const key = process.env.JUJU_SM4_KEY;
  if (!key || !KEY_HEX_PATTERN.test(key)) {
    throw new Error(
      '[SM4] JUJU_SM4_KEY is missing or invalid — must be 32 hex chars (16 bytes). ' +
      'Generate: openssl rand -hex 16'
    );
  }
  return key;
}

/**
 * 判定文本是否已是本模块产出的密文（`v1.` 前缀）。
 * @param {*} text
 * @returns {boolean}
 */
export function isCipher(text) {
  return String(text).startsWith(CIPHER_PREFIX);
}

/**
 * 加密单字段值（SM4-CBC，随机 IV）。
 *
 * - null/undefined/空串原样返回（无值不加密）；
 * - 已是密文（isCipher）短路原样返回——防二次加密（幂等）；
 * - 其余值加密后返回 `v1.<base64(iv)>.<base64(ciphertext)>`。
 *
 * @param {*} value 明文字段值（非空标量）
 * @returns {string|null|undefined} 密文串或原空值
 */
export function encryptField(value) {
  if (value === null || value === undefined || value === '') return value;

  const text = String(value);
  if (isCipher(text)) return text; // 已是密文：防二次加密，原样短路

  const iv = crypto.randomBytes(IV_BYTES);
  // sm-crypto 的 SM4 接口走 hex 通道：明文 utf8 → hex，密文 hex → base64。
  const plaintextHex = Buffer.from(text, 'utf8').toString('hex');
  const ciphertextHex = sm4.encrypt(plaintextHex, loadKey(), {
    mode: 'cbc',
    iv: iv.toString('hex'),
  });

  return `${CIPHER_PREFIX}${iv.toString('base64')}.${Buffer.from(ciphertextHex, 'hex').toString('base64')}`;
}

/**
 * 解密单字段值。读路径宽容优先——绝不抛错阻塞：
 *
 * - null/undefined/空串原样返回；
 * - 非 `v1.` 前缀（旧明文数据）：console.warn 后原样返回（双轨过渡）；
 * - 是密文但解析/解密失败：console.warn 后原样返回（脏数据不炸读路径）。
 *
 * @param {*} value 密文串（或旧明文）
 * @returns {string|null|undefined} 明文或原值
 */
export function decryptField(value) {
  if (value === null || value === undefined || value === '') return value;

  const text = String(value);
  if (!text.startsWith(CIPHER_PREFIX)) {
    console.warn(`[SM4] decryptField: value is not ciphertext (legacy plaintext?) — returned as-is: ${text.slice(0, 40)}`);
    return text;
  }

  try {
    const body = text.slice(CIPHER_PREFIX.length);
    const sep = body.indexOf('.');
    if (sep <= 0) throw new Error('malformed ciphertext: missing IV separator');
    const ivHex = Buffer.from(body.slice(0, sep), 'base64').toString('hex');
    const ciphertextHex = Buffer.from(body.slice(sep + 1), 'base64').toString('hex');
    if (!ivHex || !ciphertextHex) throw new Error('malformed ciphertext: empty IV or payload');

    const plaintextHex = sm4.decrypt(ciphertextHex, loadKey(), { mode: 'cbc', iv: ivHex });
    return Buffer.from(plaintextHex, 'hex').toString('utf8');
  } catch (err) {
    console.warn(`[SM4] decryptField: decryption failed (${err?.message || err}) — returned as-is: ${text.slice(0, 40)}`);
    return text;
  }
}

/**
 * 手机号盲指纹（HMAC-SHA256, hex）——加密态下的等值检索/去重键。
 * 空值返回 null（与列语义一致：无手机号即无指纹）。
 * @param {*} plain 明文手机号
 * @returns {string|null} 64 hex chars 或 null
 */
export function phoneHash(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const text = String(plain);
  if (!text) return null;
  return crypto.createHmac('sha256', loadKey()).update(text).digest('hex');
}
