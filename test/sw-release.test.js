/**
 * 测试：Service Worker 缓存版本号（APP_RELEASE）回归守卫
 * （v0.0.36 hotfix，software-bugfix-2fa-login 沿用）
 *
 * 为什么要有这个文件：APP_RELEASE 自 0.0.26 起从未随版本 bump，
 * 而 sw.js 内容多数版本间字节不变 → 浏览器 byte-compare 认为无更新
 * → 升级服务端后所有设备继续用旧缓存 JS/CSS（线上真实症状：概览页
 * 卡片空白、媒体编辑保存报 TypeError）。本测试确保：
 *   1) APP_RELEASE 与 package.json 的 version 严格一致（核心回归守卫）；
 *   2) sw.js 的 4 个主缓存名都内插 APP_RELEASE（命名缓存随版本失效）。
 * 读源码断言，无需起服务，零依赖（node:test）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SW_PATH = path.join(ROOT, 'public', 'sw.js');
const PKG_PATH = path.join(ROOT, 'package.json');

const swSource = fs.readFileSync(SW_PATH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const pkgVersion = pkg.version;

// ── 核心守卫：APP_RELEASE 必须与 package.json 的 version 一致 ──────────────

test('APP_RELEASE 与 package.json 的 version 严格一致', () => {
  // 从 sw.js 读取 APP_RELEASE 常量声明（第 18 行附近）。
  const m = swSource.match(/const\s+APP_RELEASE\s*=\s*'([^']+)'\s*;/);
  assert.ok(m,
    'public/sw.js 中未找到 APP_RELEASE 常量声明（形如 `const APP_RELEASE = \'x.y.z\';`）。'
    + '请检查第 18 行附近的声明。');

  const appRelease = m[1];
  assert.equal(appRelease, pkgVersion,
    `APP_RELEASE ('${appRelease}') 与 package.json 的 version ('${pkgVersion}') 不一致。\n`
    + `→ 发版时忘记 bump：把 public/sw.js 第 18 行改为  const APP_RELEASE   = '${pkgVersion}';`
    + '（缓存版本号必须随应用版本号联动，否则升级后浏览器继续用旧缓存前端）。');
});

// ── 辅助守卫：4 个主缓存名都内插 APP_RELEASE ─────────────────────────────

test('ALL_CACHES 的 4 个主缓存名都内插 APP_RELEASE', () => {
  // 期望的 4 个主缓存名前缀（不含 -${APP_RELEASE} 后缀）。
  const expectedPrefixes = [
    'yuvomi-shell',
    'yuvomi-pages',
    'yuvomi-locales',
    'yuvomi-assets',
  ];

  for (const prefix of expectedPrefixes) {
    // 匹配形如  const SHELL_CACHE = `yuvomi-shell-${APP_RELEASE}`;  的模板字符串。
    const re = new RegExp('`' + prefix + '-\\$\\{APP_RELEASE\\}\`');
    const want = '`' + prefix + '-${APP_RELEASE}`';
    assert.ok(re.test(swSource),
      `public/sw.js 缺少内插 APP_RELEASE 的缓存名（期望形如 ${want}）。\n`
      + '→ 请检查第 19-22 行的 SHELL_CACHE / PAGES_CACHE / LOCALES_CACHE / ASSETS_CACHE 声明，'
      + '确保使用模板字符串 `...${APP_RELEASE}` 而非硬编码旧版本号。');
  }

  // 额外确认 ALL_CACHES 数组确实汇集了这 4 个常量（第 27 行附近）。
  const allCachesDecl = swSource.match(/const\s+ALL_CACHES\s*=\s*\[([^\]]*)\]/);
  assert.ok(allCachesDecl,
    'public/sw.js 中未找到 ALL_CACHES 声明。请检查第 27 行附近的 `const ALL_CACHES = [...]`。');

  const members = allCachesDecl[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(members.length, 4,
    `ALL_CACHES 应恰好包含 4 个主缓存名，实际 ${members.length} 个（${members.join(', ')}）。`
    + '→ 请检查 public/sw.js 第 27 行 const ALL_CACHES = [SHELL_CACHE, PAGES_CACHE,'
    + ' LOCALES_CACHE, ASSETS_CACHE];');
});
