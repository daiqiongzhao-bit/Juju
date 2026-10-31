/**
 * 测试：Emby Watched-Sync —— 降级 bug 与 syncWatched 降级逻辑（B 修复）
 *
 * 覆盖：
 *   1) embyStatusOf 纯逻辑：Emby「取消已看」(Played=false) 且残留进度百分比
 *      >0 时，必须返回 'unplayed'（而非被残留进度误判为 'doing'）。
 *      这是 B 的核心回归点——修复前会命中 PlayedPercentage>0 而走不到
 *      'unplayed'，导致 syncWatched 无法把本地 finished 降级。
 *   2) syncWatched 降级逻辑：mock global.fetch + 注入内存库，验证 Emby 上报
 *      Played=false(残留进度) 时，本地已 finished 的影片被降级为 wish，且
 *      原本 wish 的影片不受影响。
 *
 * 复刻 media-ids.test.js 的注入方式：DB_PATH 指向临时库，再用 _setTestDatabase
 * 注入最小 schema 的内存库——不跑 155 条迁移，也不碰仓库里的真实库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 先于 import('../server/db.js') 设置：模块加载即初始化（明文库，与 media-ids 一致）。
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'juju-emby-test-')), 'yuvomi.db');
process.env.LOG_LEVEL = 'error';
// 不设 DB_ENCRYPTION_KEY -> 明文库，避免加密依赖。

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const SKIP = NODE_MAJOR >= 22 ? false : `better-sqlite3-multiple-ciphers 需要 Node >= 22（当前 v${process.versions.node}），跳过 Emby 用例`;

let embyMod = null;
let testDb = null;
let savedFetch = null;

async function setup() {
  if (embyMod) return embyMod;
  const [{ _setTestDatabase }, DatabaseMod, mediaMod] = await Promise.all([
    import('../server/db.js'),
    import('better-sqlite3-multiple-ciphers'),
    import('../server/services/media-emby.js'),
  ]);
  const Database = DatabaseMod.default;
  testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE media_item (
      id INTEGER PRIMARY KEY,
      media_type TEXT, title TEXT, status TEXT,
      watch_date TEXT, updated_at TEXT, progress TEXT,
      metadata_json TEXT
    );
  `);
  _setTestDatabase(testDb);
  embyMod = mediaMod;
  return embyMod;
}

/** Emby Items 端点的 fetch mock：任意 URL 都返回给定条目列表。 */
function mockFetch(items) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ Items: items }),
    text: async () => '',
  });
}

// ------------------------------------------------------------
// 1) embyStatusOf 纯逻辑
// ------------------------------------------------------------
test('B1: embyStatusOf —— Played=false 且有残留进度(>0) 返回 unplayed（核心回归）', { skip: SKIP }, async () => {
  const mod = await setup();
  const item = { Type: 'Movie', UserData: { Played: false, PlayedPercentage: 50 } };
  assert.equal(mod.embyStatusOf(item), 'unplayed');
});

test('B1: embyStatusOf —— 正常进行中(进度>0, 未显式取消) 仍返回 doing', { skip: SKIP }, async () => {
  const mod = await setup();
  // Played 未显式设为 false -> 残留进度应正常判为 doing（修复不应破坏此路径）。
  const item = { Type: 'Movie', UserData: { PlayedPercentage: 42 } };
  assert.equal(mod.embyStatusOf(item), 'doing');
});

test('B1: embyStatusOf —— Played=true 返回 finished', { skip: SKIP }, async () => {
  const mod = await setup();
  assert.equal(mod.embyStatusOf({ Type: 'Movie', UserData: { Played: true } }), 'finished');
});

test('B1: embyStatusOf —— Series 全部看完(UnplayedItemCount=0, PlayedItemCount>0) 返回 finished', { skip: SKIP }, async () => {
  const mod = await setup();
  const series = { Type: 'Series', UserData: { UnplayedItemCount: 0, PlayedItemCount: 12 } };
  assert.equal(mod.embyStatusOf(series), 'finished');
});

test('B1: embyStatusOf —— 显式取消(Played=false) 且 PlayedItemCount>0(残留) 返回 unplayed', { skip: SKIP }, async () => {
  const mod = await setup();
  const item = { Type: 'Movie', UserData: { Played: false, PlayedItemCount: 3, PlayedPercentage: 80 } };
  assert.equal(mod.embyStatusOf(item), 'unplayed');
});

test('B1: embyStatusOf —— 无任何状态信号 返回 null', { skip: SKIP }, async () => {
  const mod = await setup();
  assert.equal(mod.embyStatusOf({ Type: 'Movie', UserData: {} }), null);
  assert.equal(mod.embyStatusOf({}), null);
});

// ------------------------------------------------------------
// 2) syncWatched 降级逻辑（mock fetch + 注入内存库）
// ------------------------------------------------------------
test('B2: syncWatched —— Emby 取消已看(残留进度) 触发本地 finished 降级为 wish', { skip: SKIP }, async () => {
  const mod = await setup();
  // 本地库：The Matrix 已 finished；Inception 仍 wish（不应被误降级）。
  testDb.prepare('DELETE FROM media_item').run();
  const ins = testDb.prepare(
    'INSERT INTO media_item (id, media_type, title, status, metadata_json) VALUES (?,?,?,?,?)'
  );
  ins.run(1, 'movie', 'The Matrix', 'finished', null);
  ins.run(2, 'movie', 'Inception', 'wish', null);

  const cfg = { emby_url: 'http://emby.test', emby_api_key: 'k', emby_user_id: 'u1' };
  // Emby 上报：The Matrix 被「取消已看」——Played=false 但残留进度未清零。
  const items = [
    { Name: 'The Matrix', Type: 'Movie', ProductionYear: 1999, UserData: { Played: false, PlayedPercentage: 50 } },
  ];

  savedFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(items);
  try {
    const res = await mod.syncWatched(testDb, cfg);
    assert.equal(res.downgraded, 1, '应有 1 条降级');
    assert.equal(res.updated, 0, '不应有升级');
    assert.ok(res.matched >= 1, 'The Matrix 应被匹配');

    const finishedRow = testDb.prepare('SELECT status FROM media_item WHERE id = 1').get();
    assert.equal(finishedRow.status, 'wish', 'The Matrix 应从 finished 降级为 wish');

    const wishRow = testDb.prepare('SELECT status FROM media_item WHERE id = 2').get();
    assert.equal(wishRow.status, 'wish', 'Inception 应保持 wish 不变');
  } finally {
    globalThis.fetch = savedFetch;
  }
});
