/**
 * 测试：401 分流分类器（R2c hotfix，public/utils/auth-401.js）
 *
 * 背景：v0.0.33 的 api.js 对所有 401（/auth/login 除外）无条件派发
 * auth:expired → router.js 无条件 navigate('/login')。用户在 2FA 设置页
 * 输错密码（业务 401 `reason:'invalid_password'`）被直接踢回登录页，
 * 永远见不到二维码（#R2c）。修复：按 body 分流——
 *   - two_factor_required → 维持 auth:expired + detail（pending-2FA 会话）
 *   - reason             → 业务错误，不派发，ApiError 带 data.reason 给调用方
 *   - 裸 401              → 维持 auth:expired（会话真失效）
 *
 * 覆盖：三条主路径 + 服务端真实响应体形状 + 边界（空 reason、假 flag、
 *       非 JSON、非对象 body、非 401 状态）。
 *
 * 说明：auth-401.js 是零依赖纯 ESM（刻意不 import 任何 DOM/sw-register），
 *       因此可在 node:test 直接导入——api.js 本身依赖 window/document，
 *       只能在浏览器跑，逻辑全部下沉到本模块后此处即可全量覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classify401, AUTH_401_KIND } from '../public/utils/auth-401.js';

test('AUTH_401_KIND：四个取值齐全且冻结', () => {
  assert.deepEqual(
    Object.values(AUTH_401_KIND).sort(),
    ['business', 'not_401', 'session', 'two_factor'],
  );
  assert.ok(Object.isFrozen(AUTH_401_KIND));
});

// ── 服务端真实响应体形状（防止分类器与服务端契约漂移） ────────────────────

test('会话真失效：server/auth.js:499 的裸 401（Not authenticated，无 reason）→ session', () => {
  assert.equal(
    classify401(401, { error: 'Not authenticated.', code: 401 }),
    AUTH_401_KIND.SESSION,
  );
});

test('pending-2FA 会话：server/auth.js:471 的 two_factor_required 401 → two_factor', () => {
  assert.equal(
    classify401(401, { error: 'Two-factor verification required.', code: 401, two_factor_required: true }),
    AUTH_401_KIND.TWO_FACTOR,
  );
});

test('业务错误：server/routes/twofactor.js:213 的 invalid_password 401 → business', () => {
  assert.equal(
    classify401(401, { error: 'Invalid password.', code: 401, reason: 'invalid_password' }),
    AUTH_401_KIND.BUSINESS,
  );
});

test('业务错误：invalid_code / rate_limited 等同理走 business', () => {
  for (const reason of ['invalid_code', 'rate_limited', 'password_required', 'already_enabled', 'not_enabled', 'setup_required']) {
    assert.equal(
      classify401(401, { error: 'x', code: 401, reason }),
      AUTH_401_KIND.BUSINESS,
      `reason=${reason} 应判为 business`,
    );
  }
});

// ── 边界：坏 body / 空标记不得静默改判 ─────────────────────────────────────

test('非 JSON（body=null）或空对象 → session（维持既有全局处理）', () => {
  assert.equal(classify401(401, null), AUTH_401_KIND.SESSION);
  assert.equal(classify401(401), AUTH_401_KIND.SESSION); // 默认参数
  assert.equal(classify401(401, {}), AUTH_401_KIND.SESSION);
  assert.equal(classify401(401, 'Not authenticated.'), AUTH_401_KIND.SESSION); // 非对象
  assert.equal(classify401(401, []), AUTH_401_KIND.SESSION);
});

test('空串 reason / 假 two_factor_required 不构成业务/挑战标记 → session', () => {
  assert.equal(classify401(401, { reason: '' }), AUTH_401_KIND.SESSION);
  assert.equal(classify401(401, { reason: null }), AUTH_401_KIND.SESSION);
  assert.equal(classify401(401, { reason: 401 }), AUTH_401_KIND.SESSION); // 非字符串
  assert.equal(classify401(401, { two_factor_required: false }), AUTH_401_KIND.SESSION);
  assert.equal(classify401(401, { two_factor_required: 0 }), AUTH_401_KIND.SESSION);
});

test('两个标记同时出现时 two_factor_required 优先（保 v0.0.33 既有行为）', () => {
  assert.equal(
    classify401(401, { two_factor_required: true, reason: 'invalid_code' }),
    AUTH_401_KIND.TWO_FACTOR,
  );
});

test('非 401 状态一律 not_401（含 200/403/429/500）', () => {
  for (const status of [200, 204, 302, 403, 429, 500, 0]) {
    assert.equal(classify401(status, { reason: 'invalid_password' }), AUTH_401_KIND.NOT_401);
  }
});

test('分类是纯函数：同一入参多次调用结果一致、不改写入参', () => {
  const body = { error: 'Invalid password.', code: 401, reason: 'invalid_password' };
  const snapshot = JSON.stringify(body);
  assert.equal(classify401(401, body), classify401(401, body));
  assert.equal(JSON.stringify(body), snapshot);
});
