/**
 * 测试：影音 IDs 端点（R5，GET /api/v1/media/ids）
 *
 * 覆盖：/ids 与 /list 在同过滤条件下 ID 集合与顺序一致（updated_at DESC）、
 *       可见性（他人私有不可见；管理员全见）、/ids 注册在 /:id 之前
 *       （无 404 回归）、param 路由本身不坏。
 *
 * 说明：media.js 传递依赖 server/db.js（模块级 init），要求 Node >= 22；
 *       低版本整组跳过。用例自建最小 schema 的临时库经 _setTestDatabase
 *       注入——不跑 155 条迁移，也不碰仓库里的真实库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const DB_SKIP = NODE_MAJOR >= 22
  ? false
  : `better-sqlite3-multiple-ciphers 需要 Node >= 22（当前 v${process.versions.node}），跳过影音 IDs 用例`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'juju-media-ids-test-'));

// 先于 import('../server/db.js') 设置：模块加载即初始化。
process.env.DB_PATH = path.join(workDir, 'yuvomi.db');
process.env.JUJU_SM4_KEY = '0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL = 'error';

/** 最小 schema：media_item + media_member_rel + users（loadMembers 要 JOIN）。 */
function seedDatabase(Database) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE media_item (
      id INTEGER PRIMARY KEY,
      media_type TEXT, title TEXT, status TEXT, is_private INTEGER,
      creator_uid INTEGER, updated_at TEXT, comment TEXT, tags TEXT,
      cover_url TEXT, rating REAL, watch_date TEXT, metadata_json TEXT
    );
    CREATE TABLE media_member_rel (
      id INTEGER PRIMARY KEY,
      media_id INTEGER, member_uid INTEGER,
      is_shared_memory INTEGER DEFAULT 0, member_status TEXT
    );
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT);
  `);
  const ins = db.prepare(`
    INSERT INTO media_item (id, media_type, title, status, is_private, creator_uid, updated_at, comment, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // updated_at DESC 目标顺序：1(10-19) → 2(10-18) → 5(10-17) → 4(10-16) → 3(10-15)
  ins.run(1, 'movie', 'Interstellar', 'finished', 0, 1, '2026-10-19T10:00:00Z', 'great', '["科幻"]');
  ins.run(2, 'book', 'Dune', 'doing', 1, 1, '2026-10-18T10:00:00Z', '', '[]');
  ins.run(3, 'music', 'Random Access Memories', 'wish', 1, 2, '2026-10-15T10:00:00Z', '', '[]');
  ins.run(4, 'movie', 'The Dark Knight', 'finished', 0, 2, '2026-10-16T10:00:00Z', '', '[]');
  ins.run(5, 'movie', 'Nope', 'wish', 0, 1, '2026-10-17T10:00:00Z', '', '[]');
  db.prepare('INSERT INTO media_member_rel (media_id, member_uid) VALUES (5, 5)').run();
  db.prepare("INSERT INTO users (id, username, display_name) VALUES (5, 'kid', 'Kind')").run();
  db.prepare("INSERT INTO users (id, username, display_name) VALUES (1, 'me', 'Ich')").run();
  db.prepare("INSERT INTO users (id, username, display_name) VALUES (2, 'other', 'Andere')").run();
  return db;
}

/**
 * 挂载 media Router 到临时 HTTP 端口。
 * @param {{id:number, role?:string}} user
 */
async function serveMedia(user) {
  const [{ default: router }, db, expressMod, Database] = await Promise.all([
    import('../server/routes/media.js'),
    import('../server/db.js'),
    import('express'),
    import('better-sqlite3-multiple-ciphers'),
  ]);
  // CJS-Interop: dynamischer import liefert den Namespace, die Factory
  // steckt in .default (statisches `import express from 'express'` wie in
  // media.js erledigt diesen Schritt automatisch).
  const express = expressMod.default;
  db._setTestDatabase(seedDatabase(Database.default));
  const app = express();
  app.use(express.json());
  app.use('/api/v1/media', (req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/v1/media', router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const get = (p) => fetch(`http://127.0.0.1:${port}/api/v1/media${p}`).then((r) => r.json());
  return {
    get,
    port,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('/ids：与 /list 同过滤条件下 ID 集合与顺序一致，他人私有不可见', { skip: DB_SKIP }, async () => {
  const app = await serveMedia({ id: 1 });
  try {
    const ids = (await app.get('/ids')).data;
    // user 1 看得见：公开(1,4,5) + 自己的私有(2)；看不见 user 2 的私有(3)
    assert.deepEqual(ids, [1, 2, 5, 4]); // updated_at DESC

    const list = (await app.get('/list?limit=100')).data.map((it) => it.id);
    assert.deepEqual(list, ids);
  } finally {
    await app.close();
  }
});

test('/ids：type/status/member/q 过滤与 /list 逐一一致', { skip: DB_SKIP }, async () => {
  const app = await serveMedia({ id: 1 });
  try {
    for (const filter of ['type=movie', 'status=finished', 'status=wish', 'q=Dune', 'q=Interstellar', 'member=5']) {
      const ids = (await app.get(`/ids?${filter}`)).data;
      const list = (await app.get(`/list?limit=100&${filter}`)).data.map((it) => it.id);
      assert.deepEqual(ids, list, `Filter ${filter} weicht ab`);
    }
    // 具体值抽检：movie 且 user1 可见 → 1,5,4；member=5 → [5]
    assert.deepEqual((await app.get('/ids?type=movie')).data, [1, 5, 4]);
    assert.deepEqual((await app.get('/ids?member=5')).data, [5]);
    assert.deepEqual((await app.get('/ids?q=Dune')).data, [2]);
  } finally {
    await app.close();
  }
});

test('/ids：管理员可见他人私有条目', { skip: DB_SKIP }, async () => {
  const app = await serveMedia({ id: 2, role: 'admin' });
  try {
    const ids = (await app.get('/ids')).data;
    assert.deepEqual(ids, [1, 2, 5, 4, 3]);
    const list = (await app.get('/list?limit=100')).data.map((it) => it.id);
    assert.deepEqual(list, ids);
  } finally {
    await app.close();
  }
});

test('/ids：注册在 /:id 之前——GET /media/ids 不落入 param 路由', { skip: DB_SKIP }, async () => {
  const app = await serveMedia({ id: 1 });
  try {
    // /ids 必须 200 + 数组；若被 /:id 抢先匹配，这里会是 404 信封
    const raw = await fetch(`http://127.0.0.1:${app.port}/api/v1/media/ids`);
    assert.equal(raw.status, 200);
    assert.ok(Array.isArray((await raw.json()).data));

    // param 路由本身不坏：不存在的 id → 404
    const missing = await app.get('/999');
    assert.equal(missing.code, 404);

    // 既有顺序约束无回归：batch-delete（同样先于 /:id）对空 ids → 400
    const bd = await fetch(`http://127.0.0.1:${app.port}/api/v1/media/batch-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });
    assert.equal(bd.status, 400);
  } finally {
    await app.close();
  }
});
