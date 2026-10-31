/**
 * 测试：2FA 登录回归（v0.0.35 hotfix，software-bugfix-2fa-login）
 *
 * 背景：v0.0.29 引入 2FA/TOTP 登录后两个线上报障——
 *   ① 登录页两步表单永远同显：public/styles/auth.css 的
 *      `.auth-form { display: flex }` 优先级高于 UA 的
 *      `[hidden] { display: none }`，#twofa-form 模板里的 hidden
 *      属性被完全压住，用户同时看到密码表单和验证码表单。
 *   ② 关闭 2FA 后登录页残留验证码步骤：POST /disable 的 UPDATE
 *      成功后没有清理 req.session.pending2fa，GET /status 又只信
 *      session 不信 DB——关掉 2FA 的用户刷新页面仍被钉在码步。
 *
 * 覆盖：
 *   - CSS 守卫：`.auth-form[hidden] { display: none }` 存在且排在
 *     基础规则之后；login.js 模板 #twofa-form 带 hidden、#auth-form 不带；
 *     修复不走 !important 全局规则。
 *   - GET /status 自愈：DB 里 totp_enabled=0 但 session 残留 pending
 *     → two_factor_pending=false 且 pending2fa/pending2faSince 被删。
 *   - 正向对照：DB totp_enabled=1 且 pending → two_factor_pending=true，
 *     session 字段保持不动（自愈不得误伤正常 pending 登录）。
 *   - 无 session 的普通已登录请求：two_factor_pending=false，不炸。
 *   - POST /disable 成功：DB 四列清零 + pending session 字段被删。
 *
 * 约束：node:test + node:assert/strict，零新依赖。twofactor.js 传递依赖
 *       server/db.js 与 auth.js（模块级 SESSION_SECRET 检查 + DB 初始化），
 *       因此路由级用例与既有惯例一致：Node < 22 整组跳过；DB_PATH 指向
 *       临时目录，最小 schema 经 _setTestDatabase 注入，不跑 155 条迁移，
 *       express 临时端口挂载 router。CSS 用例是纯文件断言，无环境要求。
 *
 * QA 轮次增补（严过关，v0.0.35 验证）：
 *   - 文本断言补强：基础 .auth-form 规则不得含 !important（否则无
 *     !important 的守卫规则会输掉级联，而原测试照样全绿）；
 *     #twofa-form 必须带 auth-form class（守卫只保护这个 class）。
 *   - 浏览器级联验证独立成文件 test/login-twofa-css.test.js（puppeteer，
 *     devDependency 已有）：文本管得了「文件里写了什么」，管不了「浏览器
 *     算出什么」。
 *   - 路由级新增：POST /verify 主流程（TOTP / 恢复码 / 禁用中自愈 /
 *     无 pending / 错误码不清挑战）与 POST /disable 失败路径——原 7 个
 *     用例对「2FA 正常登录主流程」零覆盖，修复 2a/2b 共享的 pending
 *     清理模式在 /verify 里没有任何回归保护。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const DB_SKIP = NODE_MAJOR >= 22
  ? false
  : `better-sqlite3-multiple-ciphers 需要 Node >= 22（当前 v${process.versions.node}），跳过 2FA 登录用例`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'juju-2fa-login-test-'));

const savedEnv = {
  DB_PATH: process.env.DB_PATH,
  JUJU_SM4_KEY: process.env.JUJU_SM4_KEY,
  DB_ENCRYPTION_KEY: process.env.DB_ENCRYPTION_KEY,
  LOG_LEVEL: process.env.LOG_LEVEL,
  SESSION_SECRET: process.env.SESSION_SECRET,
  RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_ATTEMPTS: process.env.RATE_LIMIT_MAX_ATTEMPTS,
};

// 必须在 import('../server/routes/twofactor.js') 之前设置：
// db.js 模块加载即解析 DB_PATH；auth.js 模块加载即检查 SESSION_SECRET；
// twoFactorLimiter 模块加载即读取限流参数。
process.env.DB_PATH = path.join(workDir, 'yuvomi.db');
process.env.JUJU_SM4_KEY = '0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL = 'error';
delete process.env.DB_ENCRYPTION_KEY;
process.env.SESSION_SECRET = 'unit-test-session-secret-not-for-production';
// 限流窗口拉满：/disable 带 twoFactorLimiter（5 次/60s），测试只发一两次，
// 但同窗口内若与其他用例撞 IP 桶会误伤 429——这里显式放宽。
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.RATE_LIMIT_MAX_ATTEMPTS = '100';

/** 读取仓库内的源文件（CSS 守卫断言用，不 import 浏览器侧模块）。 */
function readRepoFile(relPath) {
  return fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8');
}

// ── ① CSS 守卫：.auth-form 的 display 不得压住 [hidden] ──────────────────

test('CSS：.auth-form[hidden] 守卫规则存在、声明 display:none、排在基础规则之后', () => {
  const css = readRepoFile('public/styles/auth.css');

  const baseIdx = css.search(/\.auth-form\s*\{[^}]*display:\s*flex/);
  assert.ok(baseIdx !== -1, 'auth.css 应保留 .auth-form 基础规则（display: flex）');

  // QA 增补：基础规则一旦带上 !important，无 !important 的守卫规则就会输掉
  // 级联——文本顺序断言届时依然全绿，浏览器里两个表单照样同显。
  const baseBlock = css.match(/\.auth-form\s*\{[^}]*\}/);
  assert.ok(baseBlock, 'auth.css 应包含 .auth-form 基础规则块');
  assert.doesNotMatch(baseBlock[0], /!important/,
    '.auth-form 基础规则不得使用 !important（守卫规则没有 !important，会输掉级联）');

  const guardIdx = css.search(/\.auth-form\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.ok(guardIdx !== -1, 'auth.css 缺少 .auth-form[hidden] { display: none } 守卫规则');
  assert.ok(guardIdx > baseIdx, '守卫规则必须排在 .auth-form 基础规则之后（同源顺序即优先级）');
});

test('CSS：修复不得使用 !important 全局 [hidden] 规则', () => {
  const css = readRepoFile('public/styles/auth.css');
  // 精准属性选择器守卫即可；全局 `[hidden] { display: none !important }`
  // 会连带压掉其他组件合法的 display 覆盖，属于过度修复。
  assert.doesNotMatch(css, /\[hidden\][^{}]*\{[^}]*!important/);
});

test('login.js 模板：#twofa-form 默认隐藏、#auth-form 默认可见', () => {
  const src = readRepoFile('public/pages/login.js');

  // 两步表单（验证码）初始带 hidden——配合 CSS 守卫，加载时只显示密码表单。
  // QA 增补：必须同时带 auth-form class——守卫规则只保护这个 class，
  // 少了它 #twofa-form 既丢样式又脱离守卫覆盖范围。
  assert.match(src, /<form id="twofa-form" class="auth-form"[^>]*\bhidden\b/,
    '#twofa-form 模板应带 hidden 属性且带 auth-form class');

  // 主表单（账号密码）不得带 hidden，否则守卫规则会把唯一该显示的表单也藏掉。
  const authFormTag = src.match(/<form class="auth-form" id="auth-form"[^>]*>/);
  assert.ok(authFormTag, 'login.js 应包含 <form class="auth-form" id="auth-form">');
  assert.doesNotMatch(authFormTag[0], /\bhidden\b/, '#auth-form 不应带 hidden');
});

// ── ②③ 路由级：/status 自愈 + /disable 清 pending ────────────────────────

/** 测试用密码（bcrypt 哈希后写入种子库）。 */
const TEST_PASSWORD = 'correct-horse-battery-staple';

/**
 * QA 增补：pending 会话替身。regenerate 是 /verify 成功路径
 * （setupAuthSession）唯一需要的会话方法；其余用例用不到但无害。
 */
function makePendingSession() {
  return {
    pending2fa: true,
    pending2faSince: '2026-10-20T09:00:00.000Z',
    csrfToken: 'tok',
    regenerate(cb) { cb(null); },
  };
}

/** QA 增补：当前 TOTP 步的有效码（verifyCode 默认 ±1 步容忍）。 */
async function currentTotpCode(secret) {
  const totpMod = await import('../server/services/totp.js');
  return totpMod.hotp(secret, Math.floor(Date.now() / 1000 / 30));
}

/** QA 增补：窗口之外的码——确定性无效，不靠运气。 */
async function staleTotpCode(secret, stepsAhead = 1000) {
  const totpMod = await import('../server/services/totp.js');
  return totpMod.hotp(secret, Math.floor(Date.now() / 1000 / 30) + stepsAhead);
}

/**
 * 最小 schema：loadUser 只 SELECT users 的 2FA 相关列。
 * QA 增补：access_permissions（clientPermissions → loadSubjectRows）与
 * split_expense_guest_users（publicLoginUser）是 /verify 成功响应构建的
 * 必经查询——原 schema 缺这两张表时，任何 /verify 成功路径都会 500。
 * @param {Function} Database better-sqlite3-multiple-ciphers 构造器
 * @param {Function} hashPassword server/utils/password.js（异步，bcrypt）
 * @param {Function} encryptField server/services/sm4.js
 * @param {Function} generateSecret server/services/totp.js
 * @param {Function} generateRecoveryCodes server/services/totp.js
 * @param {Function} serializeRecoveryCodes server/services/totp.js
 */
async function seedDatabase(Database, hashPassword, encryptField, generateSecret, generateRecoveryCodes, serializeRecoveryCodes) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT, display_name TEXT,
      avatar_color TEXT, avatar_data TEXT,
      role TEXT, family_role TEXT,
      password_hash TEXT,
      totp_secret TEXT, totp_enabled INTEGER DEFAULT 0,
      totp_enabled_at TEXT, totp_recovery_codes TEXT
    );
    CREATE TABLE access_permissions (
      subject_type TEXT, subject_id TEXT,
      resource_type TEXT, resource_key TEXT, access TEXT
    );
    CREATE TABLE split_expense_guest_users (
      user_id INTEGER, group_id INTEGER, created_by INTEGER, created_at TEXT
    );
  `);

  const passwordHash = await hashPassword(TEST_PASSWORD);

  // 用户 1（alice）：2FA 未开、无 secret——/status 自愈的题材。
  db.prepare(`
    INSERT INTO users (id, username, display_name, role, password_hash, totp_enabled)
    VALUES (1, 'alice', 'Alice', 'admin', ?, 0)
  `).run(passwordHash);

  // 用户 2（bob）：2FA 已开，secret 与恢复码按生产路径 SM4 加密落库。
  const secret = generateSecret();
  const recoveryCodes = generateRecoveryCodes(2);
  db.prepare(`
    INSERT INTO users (id, username, display_name, role, password_hash,
                       totp_secret, totp_enabled, totp_enabled_at, totp_recovery_codes)
    VALUES (2, 'bob', 'Bob', 'member', ?, ?, 1, ?, ?)
  `).run(
    passwordHash,
    encryptField(secret),
    '2026-10-01T10:00:00.000Z',
    encryptField(serializeRecoveryCodes(recoveryCodes)),
  );

  return { db, secret, recoveryCodes };
}

/**
 * 挂载 twofactor Router 到临时 HTTP 端口，并注入 req.authUserId / req.session。
 * @param {{userId:number, session?:object}} opts
 * @returns {Promise<{get:Function, post:Function, close:Function, session:object}>}
 */
async function serveTwoFactor({ userId, session }) {
  const [{ default: router }, db, expressMod, Database, passwordMod, sm4Mod, totpMod] = await Promise.all([
    import('../server/routes/twofactor.js'),
    import('../server/db.js'),
    import('express'),
    import('better-sqlite3-multiple-ciphers'),
    import('../server/utils/password.js'),
    import('../server/services/sm4.js'),
    import('../server/services/totp.js'),
  ]);
  const express = expressMod.default;
  const seeded = await seedDatabase(
    Database.default,
    passwordMod.hashPassword,
    sm4Mod.encryptField,
    totpMod.generateSecret,
    totpMod.generateRecoveryCodes,
    totpMod.serializeRecoveryCodes,
  );
  db._setTestDatabase(seeded.db);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth/2fa', (req, _res, next) => {
    req.authUserId = userId;
    if (session) req.session = session;
    next();
  });
  app.use('/api/v1/auth/2fa', router);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const call = (method, p, body) => fetch(`http://127.0.0.1:${port}/api/v1/auth/2fa${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    session,
    secret: seeded.secret,
    recoveryCodes: seeded.recoveryCodes,
    get: (p = '') => call('GET', p).then((r) => r.json()),
    post: (p, body) => call('POST', p, body).then((r) => r.json()),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('GET /status 自愈：DB 已关 2FA + session 残留 pending → two_factor_pending=false 且字段被删',
  { skip: DB_SKIP }, async () => {
  const session = { pending2fa: true, pending2faSince: '2026-10-20T09:00:00.000Z', csrfToken: 'tok' };
  const app = await serveTwoFactor({ userId: 1, session });
  try {
    const body = await app.get('/status');

    assert.equal(body.data.enabled, false, 'alice 的 2FA 在 DB 里是关的');
    assert.equal(body.data.two_factor_pending, false,
      'DB 说没开 2FA：session 里的 pending 残留不得冒充待验证状态');
    // 自愈：两个字段都必须从 session 删除，否则登录页永远停在码步。
    assert.equal('pending2fa' in session, false, 'pending2fa 应被删除');
    assert.equal('pending2faSince' in session, false, 'pending2faSince 应被删除');
    // 无关字段不受影响。
    assert.equal(session.csrfToken, 'tok');
  } finally {
    await app.close();
  }
});

test('GET /status 正向对照：DB 已开 2FA + pending → two_factor_pending=true，session 不动',
  { skip: DB_SKIP }, async () => {
  const session = { pending2fa: true, pending2faSince: '2026-10-20T09:00:00.000Z', csrfToken: 'tok' };
  const app = await serveTwoFactor({ userId: 2, session });
  try {
    const body = await app.get('/status');

    assert.equal(body.data.enabled, true);
    assert.equal(body.data.has_pending_setup, false, 'bob 已启用 2FA，不存在半成品 setup');
    assert.equal(body.data.recovery_codes_remaining, 2);
    assert.equal(body.data.two_factor_pending, true,
      'DB 开着 2FA：pending session 是合法的第二步登录挑战，不得被自愈误删');
    assert.equal(session.pending2fa, true, 'pending2fa 应保持原值');
    assert.equal(session.pending2faSince, '2026-10-20T09:00:00.000Z', 'pending2faSince 应保持原值');
  } finally {
    await app.close();
  }
});

test('GET /status 自愈兜底：delete 未生效的会话（存储不持久化）下 pending 仍不得冒充待验证',
  { skip: DB_SKIP }, async () => {
  // 防御纵深：自愈的 delete 若因会话存储未持久化而未生效，响应里的
  // `&& enabled` 必须独立把 two_factor_pending 按下去——否则登录页刷新后
  // 仍卡在码步。用吞掉 delete 的 Proxy 会话精确制造这个局面。
  const session = new Proxy({
    pending2fa: true,
    pending2faSince: '2026-10-20T09:00:00.000Z',
    csrfToken: 'tok',
  }, {
    deleteProperty() { return true; }, // delete 吞掉，属性原地不动
  });
  const app = await serveTwoFactor({ userId: 1, session });
  try {
    const body = await app.get('/status');
    assert.equal(body.data.enabled, false);
    assert.equal(body.data.two_factor_pending, false,
      '即使 session 删除未生效，DB 关着 2FA 就不得报告待验证状态');
    assert.equal(session.pending2fa, true, 'Proxy 会话里字段应原地未动（制造该局面）');
  } finally {
    await app.close();
  }
});

test('GET /status 无 session（普通已登录请求）：two_factor_pending=false，不抛错',
  { skip: DB_SKIP }, async () => {
  const app = await serveTwoFactor({ userId: 2 });
  try {
    const body = await app.get('/status');
    assert.equal(body.data.enabled, true);
    assert.equal(body.data.two_factor_pending, false, '没有 pending session 就没有待验证状态');
  } finally {
    await app.close();
  }
});

test('POST /disable 成功：DB 四列清零 + pending session 字段被删',
  { skip: DB_SKIP }, async () => {
  const session = { pending2fa: true, pending2faSince: '2026-10-20T09:00:00.000Z', csrfToken: 'tok' };
  const app = await serveTwoFactor({ userId: 2, session });
  try {
    // 当前时间窗的有效 TOTP 码（verifyCode 默认 ±1 步容忍）。
    const code = (await import('../server/services/totp.js'))
      .hotp(app.secret, Math.floor(Date.now() / 1000 / 30));

    const body = await app.post('/disable', { password: TEST_PASSWORD, code });

    assert.equal(body.data?.enabled, false, '/disable 应返回 enabled:false');

    // session 清理（Bug 2）： reload 后不得再落进登录页的码步。
    assert.equal('pending2fa' in session, false, 'pending2fa 应被删除');
    assert.equal('pending2faSince' in session, false, 'pending2faSince 应被删除');
    assert.equal(session.csrfToken, 'tok', '无关字段不受影响');

    // DB 落库：secret/codes/enabled/时间戳全部清掉（与路由里的 UPDATE 一致）。
    const row = (await import('../server/db.js')).get()
      .prepare('SELECT totp_secret, totp_enabled, totp_enabled_at, totp_recovery_codes FROM users WHERE id = 2')
      .get();
    assert.equal(row.totp_secret, null);
    assert.equal(Number(row.totp_enabled), 0);
    assert.equal(row.totp_enabled_at, null);
    assert.equal(row.totp_recovery_codes, null);
  } finally {
    await app.close();
  }
});

// ── QA 增补：/verify 主流程（场景 E 的回归保护） ───────────────────────────

test('POST /verify 正常 TOTP 码：登录完成、pending 清除、CSRF 轮换、session 升格',
  { skip: DB_SKIP }, async () => {
  const session = makePendingSession();
  const app = await serveTwoFactor({ userId: 2, session });
  try {
    const body = await app.post('/verify', { code: await currentTotpCode(app.secret) });

    assert.equal(body.user?.id, 2, 'verify 成功应返回与普通登录一致的用户块');
    assert.equal(body.user?.username, 'bob');
    assert.equal(body.user?.access_scope, 'family');
    assert.ok(body.permissions && typeof body.permissions.modules === 'object',
      '响应应带权限块（modules 为 map，不是数组）');
    assert.equal(body.permissions.admin, false, 'bob 是 member，不应拿 admin 权限');
    assert.equal(typeof body.csrfToken, 'string');
    assert.notEqual(body.csrfToken, 'tok', 'verify 成功后 CSRF 应轮换（setupAuthSession）');

    // session 升格为完整登录态，pending 痕迹清零。
    assert.equal(session.userId, 2, 'setupAuthSession 应写入 userId');
    assert.equal('pending2fa' in session, false, 'pending2fa 应被删除');
    assert.equal('pending2faSince' in session, false, 'pending2faSince 应被删除');
  } finally {
    await app.close();
  }
});

test('POST /verify 恢复码：一次性消费（DB 标记 used_at，剩余 2→1）',
  { skip: DB_SKIP }, async () => {
  const session = makePendingSession();
  const app = await serveTwoFactor({ userId: 2, session });
  try {
    const body = await app.post('/verify', { code: app.recoveryCodes[0] });
    assert.equal(body.user?.id, 2, '有效恢复码应完成登录');
    assert.equal('pending2fa' in session, false, 'pending2fa 应被删除');

    // 落库检查：用过的那个码带 used_at，另一个仍可用。
    // 注意：server/db.js 是命名空间导出（无 default），与文件内其他 import 一致。
    const [db, { decryptField }, { parseRecoveryCodes }] = await Promise.all([
      import('../server/db.js'),
      import('../server/services/sm4.js'),
      import('../server/services/totp.js'),
    ]);
    const row = db.get()
      .prepare('SELECT totp_recovery_codes FROM users WHERE id = 2')
      .get();
    const entries = parseRecoveryCodes(decryptField(row.totp_recovery_codes));
    assert.equal(entries.length, 2, '恢复码条目数不应变化（标记而非删除）');
    assert.equal(entries.filter((e) => e.used_at).length, 1, '应恰好一个码被标记为已用');

    // 与 /status 的计数口径一致：剩余 1。
    const status = await app.get('/status');
    assert.equal(status.data.recovery_codes_remaining, 1);
  } finally {
    await app.close();
  }
});

test('POST /verify 自愈：pending 会话但 DB 已关 2FA → 无需码直接放行 + pending 清除',
  { skip: DB_SKIP }, async () => {
  // 场景 D 的服务端另一半：另一个标签页关掉 2FA 后，旧 pending 会话
  // 提交任何内容都应被放行并清场，而不是永远钉在 401。
  const session = makePendingSession();
  const app = await serveTwoFactor({ userId: 1, session });
  try {
    const body = await app.post('/verify', {}); // 故意不带 code

    assert.equal(body.user?.username, 'alice');
    assert.equal(body.csrfToken, 'tok', '自愈路径不重建会话，CSRF 原样返回');
    assert.equal('pending2fa' in session, false, 'pending2fa 应被删除');
    assert.equal('pending2faSince' in session, false, 'pending2faSince 应被删除');
  } finally {
    await app.close();
  }
});

test('POST /verify 无 pending 会话 → 409 not_pending',
  { skip: DB_SKIP }, async () => {
  const app = await serveTwoFactor({
    userId: 2,
    session: { csrfToken: 'tok', regenerate(cb) { cb(null); } },
  });
  try {
    const res = await app.post('/verify', { code: '123456' });
    assert.equal(res.code, 409);
    assert.equal(res.reason, 'not_pending', '没有待验证挑战时不得尝试验码');
  } finally {
    await app.close();
  }
});

test('POST /verify 错误码 → 401 invalid_code 且挑战不清除',
  { skip: DB_SKIP }, async () => {
  const session = makePendingSession();
  const app = await serveTwoFactor({ userId: 2, session });
  try {
    const res = await app.post('/verify', { code: await staleTotpCode(app.secret) });
    assert.equal(res.code, 401);
    assert.equal(res.reason, 'invalid_code');
    assert.equal(session.pending2fa, true, '失败的验证不得把 pending 挑战修掉');
    assert.equal(session.pending2faSince, '2026-10-20T09:00:00.000Z', 'pending2faSince 应保持原值');
  } finally {
    await app.close();
  }
});

test('POST /disable 失败（错误码）→ 400 且 pending 会话与 DB 不受影响',
  { skip: DB_SKIP }, async () => {
  // 修复 2a 的清理必须只在成功路径跑——失败的禁用尝试清掉 pending 会让
  // 攻击者用错误码把受害者挤下线（或反之制造混乱）。
  const session = makePendingSession();
  const app = await serveTwoFactor({ userId: 2, session });
  try {
    const res = await app.post('/disable', { password: TEST_PASSWORD, code: await staleTotpCode(app.secret) });
    assert.equal(res.code, 400);
    assert.equal(res.reason, 'invalid_code');

    assert.equal(session.pending2fa, true, '失败的 /disable 不得清 pending');
    assert.equal('pending2faSince' in session, true, '失败的 /disable 不得清 pending2faSince');

    const row = (await import('../server/db.js')).get()
      .prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = 2')
      .get();
    assert.equal(Number(row.totp_enabled), 1, 'DB 里 2FA 应保持启用');
    assert.ok(row.totp_secret, 'secret 不应被清掉');
  } finally {
    await app.close();
  }
});

test.after(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(workDir, { recursive: true, force: true });
});
