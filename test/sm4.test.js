/**
 * 测试：SM4 字段加密（server/services/sm4.js）
 *
 * 覆盖：加解密往返、密文格式、随机 IV、幂等性、空值透传、错误密钥行为、
 *       手机号盲指纹。密钥通过 JUJU_SM4_KEY 注入（模块每次调用读环境变量，
 *       因此在测试里切换密钥即可模拟"换密钥"场景）。
 *
 * 说明：decryptField 对脏数据会 console.warn，测试里临时接管 console.warn
 *       以保持输出干净，结束后必定还原。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadKey,
  isCipher,
  encryptField,
  decryptField,
  phoneHash,
} from '../server/services/sm4.js';

/** 合法密钥：32 个 hex 字符 = 16 字节。 */
const KEY_A = '0123456789abcdef0123456789abcdef';
/** 另一个合法密钥，用于模拟"用错密钥解密"。 */
const KEY_B = 'fedcba9876543210fedcba9876543210';

/** 默认测试密钥，每个用例开始前复位。 */
process.env.JUJU_SM4_KEY = KEY_A;

/**
 * 执行 fn，期间吞掉 console.warn（decryptField 的预期告警）。
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withoutWarnings(fn) {
  const original = console.warn;
  const messages = [];
  console.warn = (...args) => messages.push(args.join(' '));
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

test('loadKey: 合法密钥原样返回，缺失或格式非法时抛错', () => {
  process.env.JUJU_SM4_KEY = KEY_A;
  assert.equal(loadKey(), KEY_A);

  const saved = process.env.JUJU_SM4_KEY;
  try {
    delete process.env.JUJU_SM4_KEY;
    assert.throws(() => loadKey(), /JUJU_SM4_KEY is missing or invalid/);

    process.env.JUJU_SM4_KEY = 'too-short';
    assert.throws(() => loadKey(), /JUJU_SM4_KEY is missing or invalid/);

    process.env.JUJU_SM4_KEY = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'; // 32 位但非 hex
    assert.throws(() => loadKey(), /JUJU_SM4_KEY is missing or invalid/);
  } finally {
    process.env.JUJU_SM4_KEY = saved ?? KEY_A;
  }
});

test('加解密往返：ASCII、中文、空串与 null', () => {
  for (const plain of ['Alice', '+49 170 1234567', '张三 · 上海市浦东新区 1 号', 'a'.repeat(500)]) {
    const cipher = encryptField(plain);
    assert.ok(isCipher(cipher), `密文必须带 v1. 前缀：${cipher}`);
    assert.equal(decryptField(cipher), plain);
  }

  // 空值不加密，原样返回（与列的"无值"语义一致）。
  assert.equal(encryptField(''), '');
  assert.equal(encryptField(null), null);
  assert.equal(encryptField(undefined), undefined);
  assert.equal(decryptField(''), '');
  assert.equal(decryptField(null), null);
  assert.equal(decryptField(undefined), undefined);
});

test('密文格式：v1.<base64(iv)>.<base64(ciphertext)>，IV 16 字节', () => {
  const cipher = encryptField('13800138000');
  assert.ok(cipher.startsWith('v1.'));

  const body = cipher.slice('v1.'.length);
  const parts = body.split('.');
  assert.equal(parts.length, 2);

  const iv = Buffer.from(parts[0], 'base64');
  const payload = Buffer.from(parts[1], 'base64');
  assert.equal(iv.length, 16, 'SM4-CBC 的 IV 必须是 16 字节');
  assert.ok(payload.length > 0);

  // 明文按 16 字节分组填充，密文长度必为分组长度的整数倍。
  assert.equal(payload.length % 16, 0);
});

test('同一明文两次加密结果不同（随机 IV，防等值比对）', () => {
  const first = encryptField('13800138000');
  const second = encryptField('13800138000');
  assert.notEqual(first, second);
  assert.equal(decryptField(first), decryptField(second));
});

test('幂等：已是密文的值不会被二次加密', () => {
  const cipher = encryptField('13800138000');
  assert.equal(encryptField(cipher), cipher);
  assert.equal(decryptField(encryptField(cipher)), '13800138000');
});

test('错误密钥：解密失败时按约定原样返回并告警，绝不抛错', () => {
  process.env.JUJU_SM4_KEY = KEY_A;
  const cipher = encryptField('13800138000');

  process.env.JUJU_SM4_KEY = KEY_B;
  const result = withoutWarnings(() => decryptField(cipher));

  // 读路径宽容优先：返回入参本身（或解密出的乱码），但一定不等于明文。
  assert.notEqual(result, '13800138000');
  assert.equal(typeof result, 'string');

  process.env.JUJU_SM4_KEY = KEY_A;
  assert.equal(decryptField(cipher), '13800138000');
});

test('脏数据：非密文与残缺密文都原样返回（不阻断读路径）', () => {
  const legacy = '13800138000';
  assert.equal(withoutWarnings(() => decryptField(legacy)), legacy);

  const broken = 'v1.broken-without-separator';
  assert.equal(withoutWarnings(() => decryptField(broken)), broken);

  const emptyPayload = `v1.${Buffer.alloc(16).toString('base64')}.`;
  assert.equal(withoutWarnings(() => decryptField(emptyPayload)), emptyPayload);
});

test('isCipher: 只认 v1. 前缀', () => {
  assert.equal(isCipher(encryptField('x')), true);
  assert.equal(isCipher('v1.'), true);
  assert.equal(isCipher('13800138000'), false);
  assert.equal(isCipher(''), false);
  assert.equal(isCipher(null), false);
});

test('phoneHash: 稳定、64 位 hex、空值为 null、随密钥变化', () => {
  process.env.JUJU_SM4_KEY = KEY_A;
  const first = phoneHash('+49 170 1234567');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(phoneHash('+49 170 1234567'), first, '同一明文必须得到同一指纹');
  assert.notEqual(phoneHash('+49 170 1234568'), first);

  assert.equal(phoneHash(''), null);
  assert.equal(phoneHash(null), null);
  assert.equal(phoneHash(undefined), null);

  process.env.JUJU_SM4_KEY = KEY_B;
  assert.notEqual(phoneHash('+49 170 1234567'), first, '换密钥后盲指纹必须变化');
  process.env.JUJU_SM4_KEY = KEY_A;
});

test('端到端：加密入库 → 用密文做等值查找 → 解密读出', () => {
  const stored = encryptField('+49 170 1234567');
  const index = phoneHash('+49 170 1234567');
  assert.ok(isCipher(stored));

  // 加密态下的等值检索：比对指纹，不需要解密。
  assert.equal(phoneHash(decryptField(stored)), index);
  assert.equal(decryptField(stored), '+49 170 1234567');
});
