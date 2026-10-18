/**
 * 测试：TOTP / 2FA 服务（server/services/totp.js）
 *
 * 覆盖：RFC 6238 官方测试向量、base32 编解码、otpauth URI、恢复码的生成/消费/作废。
 * 约束：node:test + node:assert，纯内存，无网络、无文件、无环境变量依赖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STEP_SECONDS,
  DIGITS,
  DEFAULT_WINDOW,
  RECOVERY_CODE_COUNT,
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  verifyCode,
  normalizeCode,
  otpauthUri,
  otpauthQrSvg,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  serializeRecoveryCodes,
  parseRecoveryCodes,
  consumeRecoveryCode,
  remainingRecoveryCodes,
} from '../server/services/totp.js';

/**
 * RFC 6238 附录 B 的测试向量（算法 HMAC-SHA1）。
 * 原文给的是 8 位码，这里取其后 6 位——本项目 DIGITS = 6。
 */
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_VECTORS = [
  { unixtime: 59, code: '287082' },
  { unixtime: 1111111109, code: '081804' },
  { unixtime: 1111111111, code: '050471' },
  { unixtime: 1234567890, code: '005924' },
  { unixtime: 2000000000, code: '279037' },
  { unixtime: 20000000000, code: '353130' },
];

test('导出常量符合 RFC 6238 / Google Authenticator 约定', () => {
  assert.equal(STEP_SECONDS, 30);
  assert.equal(DIGITS, 6);
  assert.equal(DEFAULT_WINDOW, 1);
  assert.equal(RECOVERY_CODE_COUNT, 8);
});

test('base32Encode: 与 RFC 6238 向量一致（无 padding）', () => {
  const encoded = base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'));
  assert.equal(encoded, RFC_SECRET_BASE32);
  assert.ok(!encoded.includes('='), 'base32 不应包含 = 填充');
});

test('base32Decode: 往返正确，且宽容处理手写输入', () => {
  const buffer = Buffer.from(RFC_SECRET_ASCII, 'ascii');
  assert.ok(base32Decode(RFC_SECRET_BASE32).equals(buffer));

  // 小写、空格、连字符、'=' 填充——手抄密钥时最常见的四种噪声。
  const noisy = `  ${RFC_SECRET_BASE32.toLowerCase().slice(0, 8)}-${RFC_SECRET_BASE32.toLowerCase().slice(8)} ==`;
  assert.equal(base32Decode(noisy).toString('ascii'), RFC_SECRET_ASCII);
});

test('base32Decode: 非法输入抛错而不是静默返回', () => {
  assert.throws(() => base32Decode(''), /Secret is empty/);
  assert.throws(() => base32Decode(null), /Secret is empty/);
  assert.throws(() => base32Decode('ABC1!'), /Invalid base32 character/);
});

test('generateSecret: 20 字节熵，32 个标准 base32 字符', () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(secret).length, 20);

  // 两次生成不得相同（否则等于没有随机源）。
  assert.notEqual(generateSecret(), generateSecret());
});

test('hotp: 命中 RFC 6238 全部测试向量', () => {
  for (const { unixtime, code } of RFC_VECTORS) {
    const counter = Math.floor(unixtime / STEP_SECONDS);
    assert.equal(hotp(RFC_SECRET_BASE32, counter), code, `向量 T=${unixtime} 不匹配`);
  }
});

test('verifyCode: 正确码通过、错误码拒绝（窗口 0，严格判定）', () => {
  for (const { unixtime, code } of RFC_VECTORS) {
    const atMs = unixtime * 1000;
    assert.equal(verifyCode(RFC_SECRET_BASE32, code, { window: 0, atMs }), true, `T=${unixtime} 应通过`);
    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal(verifyCode(RFC_SECRET_BASE32, wrong, { window: 0, atMs }), false);
  }
});

test('verifyCode: ±1 时间窗容忍时钟漂移，±2 则拒绝', () => {
  const atMs = 1234567890 * 1000;
  const counter = Math.floor(1234567890 / STEP_SECONDS);
  const prevCode = hotp(RFC_SECRET_BASE32, counter - 1);
  const nextCode = hotp(RFC_SECRET_BASE32, counter + 1);
  const farCode = hotp(RFC_SECRET_BASE32, counter - 2);

  assert.equal(verifyCode(RFC_SECRET_BASE32, prevCode, { window: 0, atMs }), false);
  assert.equal(verifyCode(RFC_SECRET_BASE32, prevCode, { window: 1, atMs }), true);
  assert.equal(verifyCode(RFC_SECRET_BASE32, nextCode, { window: 1, atMs }), true);
  assert.equal(verifyCode(RFC_SECRET_BASE32, farCode, { window: 1, atMs }), false);
  assert.equal(verifyCode(RFC_SECRET_BASE32, farCode, { window: 2, atMs }), true);
});

test('verifyCode: 格式非法的输入一律拒绝（不抛错）', () => {
  const atMs = 1234567890 * 1000;
  const valid = RFC_VECTORS[3].code;
  assert.equal(verifyCode(RFC_SECRET_BASE32, valid, { window: 0, atMs }), true);

  for (const bad of ['12345', '1234567', 'abcdef', '', '   ', null, undefined, '12 3456x']) {
    assert.equal(verifyCode(RFC_SECRET_BASE32, bad, { window: 1, atMs }), false, `输入 ${String(bad)} 应被拒绝`);
  }
  // 空密钥：无论输入什么都不通过。
  assert.equal(verifyCode('', valid, { window: 1, atMs }), false);
  assert.equal(verifyCode(null, valid, { window: 1, atMs }), false);
});

test('normalizeCode: 去掉空格与连字符', () => {
  assert.equal(normalizeCode('123 456'), '123456');
  assert.equal(normalizeCode('12-34-56'), '123456');
  assert.equal(normalizeCode('  987654 '), '987654');
  assert.equal(normalizeCode(null), '');
});

test('otpauthUri: 格式符合 Google Authenticator 的解析约定', () => {
  const uri = otpauthUri({ secret: RFC_SECRET_BASE32, account: 'alice' });
  assert.ok(uri.startsWith('otpauth://totp/Juju:alice?'), uri);
  assert.ok(uri.includes(`secret=${RFC_SECRET_BASE32}`), uri);
  assert.ok(uri.includes('issuer=Juju'), uri);
  assert.ok(uri.includes('algorithm=SHA1'), uri);
  assert.ok(uri.includes('digits=6'), uri);
  assert.ok(uri.includes('period=30'), uri);

  // 账号含特殊字符时必须百分号编码，否则 URI 无法被解析器切成 label/query。
  const encoded = otpauthUri({ secret: RFC_SECRET_BASE32, account: 'a b@c.de', issuer: 'My Juju' });
  assert.ok(encoded.startsWith('otpauth://totp/My%20Juju:a%20b%40c.de?'), encoded);
  assert.ok(encoded.includes('issuer=My+Juju') || encoded.includes('issuer=My%20Juju'), encoded);
});

test('otpauthQrSvg: 输出可直接嵌入的 SVG', () => {
  const svg = otpauthQrSvg(otpauthUri({ secret: RFC_SECRET_BASE32, account: 'alice' }));
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), svg.slice(0, 60));
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(svg.includes('<rect'));
  assert.ok(!svg.includes('undefined'));
});

test('generateRecoveryCodes: 数量、格式与唯一性', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  for (const code of codes) assert.match(code, /^[0-9A-F]{5}-[0-9A-F]{5}$/);
  assert.equal(new Set(codes).size, codes.length);

  assert.equal(generateRecoveryCodes(3).length, 3);
  assert.equal(generateRecoveryCodes(0).length, 0);
});

test('normalizeRecoveryCode: 大小写与分隔符无关', () => {
  assert.equal(normalizeRecoveryCode(' abcde-12345 '), 'ABCDE12345');
  assert.equal(normalizeRecoveryCode('ABCDE12345'), 'ABCDE12345');
  assert.equal(normalizeRecoveryCode(null), '');
});

test('serializeRecoveryCodes / parseRecoveryCodes: 往返一致，脏数据降级为空数组', () => {
  const codes = generateRecoveryCodes(4);
  const json = serializeRecoveryCodes(codes);
  const parsed = parseRecoveryCodes(json);

  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map((entry) => entry.code), codes);
  assert.ok(parsed.every((entry) => entry.used_at === null));

  // 损坏/陈旧数据不得抛错（登录流程不能被一个坏字段卡死）。
  assert.deepEqual(parseRecoveryCodes(null), []);
  assert.deepEqual(parseRecoveryCodes(''), []);
  assert.deepEqual(parseRecoveryCodes('not json at all'), []);
  assert.deepEqual(parseRecoveryCodes('{"a":1}'), []);
  assert.deepEqual(parseRecoveryCodes('[{"nope":1},{"code":"ABCDE-12345"}]').length, 1);
});

test('consumeRecoveryCode: 消费成功即作废，重复提交不再有效', () => {
  const codes = generateRecoveryCodes(3);
  let entries = parseRecoveryCodes(serializeRecoveryCodes(codes));
  assert.equal(remainingRecoveryCodes(entries), 3);

  // ① 正常使用（含小写 + 空格，模拟用户手抄输入）。
  const first = consumeRecoveryCode(entries, ` ${codes[1].toLowerCase()} `);
  assert.equal(first.matched, true);
  entries = first.entries;
  assert.ok(entries[1].used_at, '被消费的码必须带上时间戳');
  assert.equal(remainingRecoveryCodes(entries), 2);

  // ② 同一个码再用一次：用后作废。
  const again = consumeRecoveryCode(entries, codes[1]);
  assert.equal(again.matched, false);
  assert.equal(remainingRecoveryCodes(again.entries), 2);

  // ③ 其余未使用的码仍然有效。
  const second = consumeRecoveryCode(entries, codes[0]);
  assert.equal(second.matched, true);
  assert.equal(remainingRecoveryCodes(second.entries), 1);

  // ④ 全部用完后不再匹配任何输入。
  const rest = consumeRecoveryCode(second.entries, codes[2]);
  assert.equal(rest.matched, true);
  assert.equal(remainingRecoveryCodes(rest.entries), 0);
  assert.equal(consumeRecoveryCode(rest.entries, codes[2]).matched, false);
});

test('consumeRecoveryCode: 空输入与不存在的码不改变原始数组', () => {
  const codes = generateRecoveryCodes(2);
  const entries = parseRecoveryCodes(serializeRecoveryCodes(codes));

  for (const bad of ['', '   ', null, undefined, 'ZZZZZ-ZZZZZ']) {
    const result = consumeRecoveryCode(entries, bad);
    assert.equal(result.matched, false);
    assert.deepEqual(result.entries, entries);
  }
});

test('端到端：新密钥 → URI → 校验 → 恢复码消费', () => {
  const secret = generateSecret();
  const uri = otpauthUri({ secret, account: 'bob@example.com', issuer: 'Juju' });
  assert.ok(uri.includes(`secret=${secret}`));

  const atMs = Date.now();
  const code = hotp(secret, Math.floor(atMs / 1000 / STEP_SECONDS));
  assert.equal(verifyCode(secret, code, { atMs }), true);

  const entries = parseRecoveryCodes(serializeRecoveryCodes(generateRecoveryCodes()));
  assert.equal(remainingRecoveryCodes(entries), RECOVERY_CODE_COUNT);
});
