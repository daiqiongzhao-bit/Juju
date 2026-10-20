/**
 * 测试：401 响应分类（public/utils/auth-401.js）
 *
 * 覆盖：三种 401 类型（TWO_FACTOR/BUSINESS/SESSION）、空 reason 字符串、
 * reason 非字符串、two_factor_required 与 reason 并存时 TWO_FACTOR 优先、
 * 非 401 返回 null、body 为 null/非对象、纯函数不改写入参、
 * 真实服务端响应体形状防漂移（server/routes/twofactor.js 的 fail() 形状）。
 * 约束：node:test + node:assert，零依赖、无网络、无 DOM。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AUTH_401_KIND, classify401 } from '../public/utils/auth-401.js';

// 1) TWO_FACTOR：two_factor_required 为真 → two_factor
test('401 + two_factor_required → TWO_FACTOR', () => {
  assert.equal(classify401(401, { two_factor_required: true }), AUTH_401_KIND.TWO_FACTOR);
  assert.equal(classify401(401, { two_factor_required: true, error: 'x' }), AUTH_401_KIND.TWO_FACTOR);
});

// 2) BUSINESS：reason 为非空字符串 → business
test('401 + 非空 reason 字符串 → BUSINESS', () => {
  assert.equal(classify401(401, { reason: 'invalid_password' }), AUTH_401_KIND.BUSINESS);
  assert.equal(classify401(401, { reason: 'rate_limited' }), AUTH_401_KIND.BUSINESS);
});

// 3) SESSION：裸 401、无 reason、无 two_factor_required → session
test('401 + 无附加信息 → SESSION', () => {
  assert.equal(classify401(401, {}), AUTH_401_KIND.SESSION);
  assert.equal(classify401(401, { error: 'Not authenticated.', code: 401 }), AUTH_401_KIND.SESSION);
});

// 4) 空 reason 字符串不构成业务拒绝 → session
test('401 + 空 reason 字符串 → SESSION', () => {
  assert.equal(classify401(401, { reason: '' }), AUTH_401_KIND.SESSION);
});

// 5) reason 非字符串 → session
test('401 + 非字符串 reason → SESSION', () => {
  assert.equal(classify401(401, { reason: 42 }), AUTH_401_KIND.SESSION);
  assert.equal(classify401(401, { reason: null }), AUTH_401_KIND.SESSION);
  assert.equal(classify401(401, { reason: ['a'] }), AUTH_401_KIND.SESSION);
});

// 6) two_factor_required 与 reason 并存 → TWO_FACTOR 优先；
//    two_factor_required 为假值时回落到 reason 判定
test('401 + two_factor_required 与 reason 并存 → TWO_FACTOR 优先', () => {
  assert.equal(
    classify401(401, { two_factor_required: true, reason: 'invalid_password' }),
    AUTH_401_KIND.TWO_FACTOR,
  );
  assert.equal(
    classify401(401, { two_factor_required: false, reason: 'invalid_password' }),
    AUTH_401_KIND.BUSINESS,
  );
  assert.equal(classify401(401, { two_factor_required: false }), AUTH_401_KIND.SESSION);
});

// 7) 非 401 → null（与本模块无关的状态码不接管）
test('非 401 状态码 → null', () => {
  assert.equal(classify401(200, { reason: 'x' }), null);
  assert.equal(classify401(403, { two_factor_required: true }), null);
  assert.equal(classify401(500, {}), null);
});

// 8) body 为 null / 非对象 → session（不抛异常）
test('401 + body 为 null/非对象 → SESSION', () => {
  assert.equal(classify401(401, null), AUTH_401_KIND.SESSION);
  assert.equal(classify401(401, undefined), AUTH_401_KIND.SESSION);
  assert.equal(classify401(401, 'Invalid credentials.'), AUTH_401_KIND.SESSION);
  assert.equal(classify401(401, 401), AUTH_401_KIND.SESSION);
});

// 9) 纯函数不改写入参（冻结对象 + 快照比对）
test('纯函数：不改写入参', () => {
  const body = Object.freeze({ two_factor_required: true, reason: 'invalid_password' });
  const snapshot = JSON.stringify(body);
  assert.doesNotThrow(() => classify401(401, body));
  assert.equal(JSON.stringify(body), snapshot);
});

// 10) 真实服务端响应体形状防漂移（server/routes/twofactor.js fail() 的
//     { error, code, reason } 契约；server/auth.js 的 pending-2FA 标记）
test('真实服务端响应体形状 → 期望分类', () => {
  // 2FA 密码错误：业务拒绝，err.data.reason 供 twofactor.js message() 映射
  assert.equal(
    classify401(401, { error: 'Invalid password.', code: 401, reason: 'invalid_password' }),
    AUTH_401_KIND.BUSINESS,
  );
  // 未登录访问受保护资源：会话过期
  assert.equal(
    classify401(401, { error: 'Not authenticated.', code: 401 }),
    AUTH_401_KIND.SESSION,
  );
  // 待验证 2FA 的 pending 会话
  assert.equal(
    classify401(401, {
      error: 'Two-factor verification required.',
      code: 401,
      two_factor_required: true,
    }),
    AUTH_401_KIND.TWO_FACTOR,
  );
});
