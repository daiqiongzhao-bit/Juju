/**
 * 测试：登录页两步表单（#auth-form ↔ #twofa-form）的浏览器级联验证
 * （v0.0.35 hotfix，software-bugfix-2fa-login）
 *
 * 为什么要有这个文件：test/twofactor-login.test.js 里的 CSS 用例是纯文本
 * 断言，只能证明「auth.css 文件里写了守卫规则」，不能证明「浏览器计算
 * 样式真的是 none」。文本断言有一整类「测试通过但 bug 还在」的漏洞：
 *   - 基础规则被加上 !important（无 !important 的守卫规则会输掉级联）；
 *   - 守卫规则被写进加载顺序错误的样式表；
 *   - 模板里的 hidden 属性被挪走或拼写变化。
 * 本文件用真实 headless Chromium 加载「从页面模板原文提取的表单 + 与
 * index.html 完全同序的样式表」，直接断言 getComputedStyle，从用户视角
 * 验证互斥显示——文本管不着的事，浏览器管。
 *
 * 覆盖场景（对应 QA 推演）：
 *   A  未启用 2FA 打开登录页：只见密码表单，#twofa-form 计算样式为 none。
 *   B  输完账号密码（login.js showTwoFactorStep 的 DOM 操作原样重放）：
 *      密码表单消失、OTP 表单出现——互斥，不同显。
 *   C  取消 OTP / 刷新后重渲染（page.reload 重放模板初始态）：
 *      回到只见密码表单。
 *   连带 join/reset 页的 .auth-form 同样受守卫保护（form.hidden=true 生效）。
 *   回归 capslock 提示与 .form-error 错误框的 hidden 切换未被 display 压住。
 *
 * 约束：puppeteer 已是 devDependency，零新依赖。Chromium 缺失时整组 skip
 *       （与既有 DB_SKIP 惯例一致），此时 CSS 修复仍有 twofactor-login.test.js
 *       的文本断言保底，但变异检出率会下降——报告需注明。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/** 与 public/index.html 完全同序的样式表——级联顺序即优先级的一部分。 */
const STYLESHEETS = [
  'tokens.css', 'reset.css', 'pwa.css', 'layout.css', 'glass.css',
  'filter-chip.css', 'sub-tabs.css', 'page-search.css', 'kitchen-tabs.css',
  'list-row.css', 'panel.css', 'user-multi-select.css', 'datepicker.css',
  'category-manager.css', 'document-attach.css', 'detail-view.css',
  'auth.css', 'typography.css',
];

/** 临时目录句柄：每个用例一个，after 钩子统一清。 */
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * 从页面模板原文提取 <form> 区块——fixture 跟着模板走，不会静默过期。
 * 模板里的 ${esc(t(...))} 占位符会原样成为文本，不影响 display 计算。
 * @param {string} source 页面模块源码
 * @param {RegExp} startRe 起始标签正则（须能唯一定位）
 * @param {string} label 失败信息用的标签
 * @returns {string} 含收尾 </form> 的完整区块
 */
function extractForm(source, startRe, label) {
  const m = source.match(startRe);
  assert.ok(m, `${label}: 模板中未找到起始标签 ${startRe}`);
  const end = source.indexOf('</form>', m.index);
  assert.ok(end !== -1, `${label}: 找不到 </form> 收尾`);
  return source.slice(m.index, end + '</form>'.length);
}

/** 组装登录页 fixture：结构与 login.js 的 DOM 层级一致。 */
function buildLoginHtml() {
  const login = fs.readFileSync(path.join(PUBLIC_DIR, 'pages/login.js'), 'utf8');
  const authForm = extractForm(login, /<form class="auth-form" id="auth-form"/, 'login #auth-form');
  const twofaForm = extractForm(login, /<form id="twofa-form"/, 'login #twofa-form');
  const links = STYLESHEETS
    .map((f) => `<link rel="stylesheet" href="file://${path.join(PUBLIC_DIR, 'styles', f)}">`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8">${links}</head>
<body>
  <div class="app-shell">
    <div class="app-content">
      <main class="auth-page" id="main-content">
        <div class="auth-wrap">
          <section class="auth-card card card--padded" aria-labelledby="auth-card-title">
${authForm}
${twofaForm}
          </section>
        </div>
      </main>
    </div>
  </div>
</body>
</html>`;
}

/** 组装 join/reset 连带受益的 fixture（两个 .auth-form 同页）。 */
function buildJoinResetHtml() {
  const join = fs.readFileSync(path.join(PUBLIC_DIR, 'pages/join.js'), 'utf8');
  const reset = fs.readFileSync(path.join(PUBLIC_DIR, 'pages/reset-password.js'), 'utf8');
  const joinForm = extractForm(join, /<form class="auth-form" id="join-form"/, 'join #join-form');
  const resetForm = extractForm(reset, /<form class="auth-form" id="reset-form"/, 'reset #reset-form');
  const links = STYLESHEETS
    .map((f) => `<link rel="stylesheet" href="file://${path.join(PUBLIC_DIR, 'styles', f)}">`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8">${links}</head>
<body>
  <div class="app-shell"><div class="app-content">
    <main class="auth-page" id="main-content"><div class="auth-wrap">
      <section class="auth-card card card--padded">
${joinForm}
${resetForm}
      </section>
    </div></main>
  </div></div>
</body>
</html>`;
}

/** 把 fixture 写进临时目录并打开，返回 { page, file }。 */
async function openFixture(html, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `juju-login-css-${name}-`));
  tempDirs.push(dir);
  const file = path.join(dir, `${name}.html`);
  fs.writeFileSync(file, html);
  const page = await browser.newPage();
  await page.goto(`file://${file}`);
  const sheets = await page.evaluate(() => document.styleSheets.length);
  assert.ok(sheets >= STYLESHEETS.length,
    `样式表未全部加载（${sheets}/${STYLESHEETS.length}）——fixture 的 file:// 链接可能失效`);
  return page;
}

/** 读计算样式（与 login.js 查询选择器保持一致）。 */
const displayOf = (page, selector) =>
  page.evaluate((s) => getComputedStyle(document.querySelector(s)).display, selector);

/** 原样重放 login.js 的切换方式：el.hidden = true/false（反映到 hidden 属性）。 */
const setHidden = (page, selector, hidden) =>
  page.evaluate((s, h) => { document.querySelector(s).hidden = h; }, selector, hidden);

// ── 浏览器实例 ────────────────────────────────────────────────────────────
// 顶层 await：skip 选项在 test() 注册时求值，必须在此之前知道 Chromium 是否
// 可用，否则缺浏览器的环境里整组会 FAIL 而不是 SKIP。
let browser = null;
let unavailable = null;
try {
  browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
} catch (err) {
  unavailable = err?.message || String(err);
}

after(async () => {
  await browser?.close();
});

function skipIfNoBrowser() {
  return unavailable ? `headless Chromium 不可用：${unavailable}` : false;
}

// ── 场景 A：初始态只见密码表单 ──────────────────────────────────────────────

test('场景 A/C：初始渲染 #auth-form 可见、#twofa-form 计算样式为 none', {
  skip: skipIfNoBrowser(),
}, async () => {
  const page = await openFixture(buildLoginHtml(), 'login');
  try {
    assert.equal(await displayOf(page, '#auth-form'), 'flex',
      '密码表单应正常显示（.auth-form 的 display:flex 生效）');
    assert.equal(await displayOf(page, '#twofa-form'), 'none',
      '未启用 2FA 时验证码表单必须真正不可见——[hidden] 不得被 .auth-form 压住');
  } finally {
    await page.close();
  }
});

// ── 场景 B：两步互斥切换 ───────────────────────────────────────────────────

test('场景 B：showTwoFactorStep 后两表单互斥（密码表单消失、OTP 表单出现）', {
  skip: skipIfNoBrowser(),
}, async () => {
  const page = await openFixture(buildLoginHtml(), 'login');
  try {
    // 原样重放 login.js showTwoFactorStep() 的两个 DOM 操作。
    await setHidden(page, '#auth-form', true);
    await setHidden(page, '#twofa-form', false);

    assert.equal(await displayOf(page, '#auth-form'), 'none',
      '切到 OTP 步后密码表单必须消失——不同显是「两步式」的最低要求');
    assert.equal(await displayOf(page, '#twofa-form'), 'flex',
      'OTP 表单应显示');
  } finally {
    await page.close();
  }
});

// ── 场景 C：取消 OTP / 刷新 → 回到初始态 ──────────────────────────────────

test('场景 C：刷新（模板重渲染）后回到只见密码表单', {
  skip: skipIfNoBrowser(),
}, async () => {
  const page = await openFixture(buildLoginHtml(), 'login');
  try {
    // 先制造「停在 OTP 步」的状态（含 pending 会话刷新那条路径）。
    await setHidden(page, '#auth-form', true);
    await setHidden(page, '#twofa-form', false);
    assert.equal(await displayOf(page, '#twofa-form'), 'flex');

    // page.reload 重放模板初始态——等价于 SPA 重新 render 时的
    // replaceChildren + insertAdjacentHTML（含 #twofa-form 的 hidden 属性）。
    await page.reload();
    assert.equal(await displayOf(page, '#auth-form'), 'flex',
      '取消 OTP/刷新后应回到密码表单');
    assert.equal(await displayOf(page, '#twofa-form'), 'none',
      '取消 OTP 后验证码表单不得残留——用户三联报障之一');
  } finally {
    await page.close();
  }
});

// ── 连带：join/reset 的 .auth-form 同样受保护 ──────────────────────────────

test('连带：join/reset 表单 form.hidden=true 时同样真正隐藏', {
  skip: skipIfNoBrowser(),
}, async () => {
  const page = await openFixture(buildJoinResetHtml(), 'join-reset');
  try {
    // join.js dead()/成功路径与 reset-password.js 成功路径都会 form.hidden = true。
    await setHidden(page, '#join-form', true);
    await setHidden(page, '#reset-form', true);
    assert.equal(await displayOf(page, '#join-form'), 'none',
      'join 表单隐藏后不得残留（邀请作废/成功加入场景）');
    assert.equal(await displayOf(page, '#reset-form'), 'none',
      'reset 表单隐藏后不得残留（重置成功场景）');

    await setHidden(page, '#join-form', false);
    await setHidden(page, '#reset-form', false);
    assert.equal(await displayOf(page, '#join-form'), 'flex');
    assert.equal(await displayOf(page, '#reset-form'), 'flex');
  } finally {
    await page.close();
  }
});

// ── 回归：同页其他 .hidden 切换元素未被 display 规则压住 ──────────────────

test('回归：capslock 提示与 .form-error 错误框的 hidden 切换正常', {
  skip: skipIfNoBrowser(),
}, async () => {
  const page = await openFixture(buildLoginHtml(), 'login');
  try {
    // capslock：.auth-capslock { display: flex } 本可压住 [hidden]，
    // 靠 .auth-capslock[hidden] 守卫（auth.css:331）——防回归。
    assert.equal(await displayOf(page, '#auth-capslock'), 'none');
    await setHidden(page, '#auth-capslock', false);
    assert.equal(await displayOf(page, '#auth-capslock'), 'flex');
    await setHidden(page, '#auth-capslock', true);
    assert.equal(await displayOf(page, '#auth-capslock'), 'none');

    // .form-error 不设 display（layout.css:2743），UA [hidden] 自然赢。
    for (const sel of ['#form-error', '#twofa-error']) {
      assert.equal(await displayOf(page, sel), 'none', `${sel} 初始应不可见`);
      await setHidden(page, sel, false);
      assert.notEqual(await displayOf(page, sel), 'none', `${sel} 显示后不得被压住`);
      await setHidden(page, sel, true);
      assert.equal(await displayOf(page, sel), 'none');
    }
  } finally {
    await page.close();
  }
});
