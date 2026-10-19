/**
 * 测试：天气反向地理编码（R3，server/routes/weather.js 的 buildRouter 工厂）
 *
 * 覆盖：反编码命中并持久化 weather_city、内存缓存命中零二次 HTTP、
 *       超时/5xx 静默回退坐标串且下次重试、手动城市零反编码请求、
 *       个人坐标覆盖写个人键不污染家庭键、lang 消毒（非法值回落 zh）。
 *
 * 说明：weather.js 传递依赖 server/db.js（模块级 init + better-sqlite3），
 *       因此与迁移/备份用例一样要求 Node >= 22；低版本 Node 整组跳过并说明
 *       原因。cfgGet/cfgSet/fetchFn 全部经工厂注入——用例不碰真实数据库与
 *       真实网络，DB_PATH 仍指向临时目录（import 时 db.js 会自动初始化）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const DB_SKIP = NODE_MAJOR >= 22
  ? false
  : `better-sqlite3-multiple-ciphers 需要 Node >= 22（当前 v${process.versions.node}），跳过天气反编码用例`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'juju-weather-geo-test-'));

// 必须在 import('../server/routes/weather.js') 之前设置：db.js 在模块加载时
// 就解析 DB_PATH 并自动初始化（工厂注入让用例本身不依赖这个库）。
process.env.DB_PATH = path.join(workDir, 'yuvomi.db');
process.env.JUJU_SM4_KEY = '0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL = 'error';

/** Open-Meteo 模拟响应（6 天预报，首日 = today 会被过滤掉）。 */
function omPayload() {
  return {
    current: {
      temperature_2m: 22,
      apparent_temperature: 21,
      relative_humidity_2m: 60,
      is_day: 1,
      weather_code: 1,
      wind_speed_10m: 10,
    },
    daily: {
      time: ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'],
      temperature_2m_max: [25, 26, 24, 23, 25, 26],
      temperature_2m_min: [15, 16, 15, 14, 15, 16],
      weather_code: [1, 2, 3, 61, 1, 0],
    },
  };
}

/**
 * 记录调用的 fetch 替身：Open-Meteo 与 BigDataCloud 按 URL 分流，
 * 每次调用记一笔账，供「零二次 HTTP」类断言使用。
 * @param {object} opts
 * @param {string|null} [opts.geoCity] 反编码返回的城市名；null = 接口失败
 * @param {boolean} [opts.geoThrow] 反编码抛错（模拟超时）
 */
function makeFetch({ geoCity = '深圳市', geoThrow = false } = {}) {
  const calls = { om: 0, geo: 0, geoUrls: [] };
  const fetchFn = async (url) => {
    if (String(url).includes('bigdatacloud')) {
      calls.geo += 1;
      calls.geoUrls.push(String(url));
      if (geoThrow) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'AbortError';
        throw err;
      }
      if (geoCity === null) return { ok: false, status: 502, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({ city: geoCity, locality: '福田区', principalSubdivision: '广东省' }),
      };
    }
    calls.om += 1;
    return { ok: true, json: async () => omPayload() };
  };
  return { fetchFn, calls };
}

/**
 * 挂载一个带注入的 weather Router 到临时 HTTP 端口。
 * @param {Map<string,string>} store sync_config 替身
 * @param {Function|null} fetchFn
 * @param {number} userId req.authUserId
 */
async function serveRouter(store, fetchFn, userId = 1) {
  const [{ buildRouter }, expressMod] = await Promise.all([
    import('../server/routes/weather.js'),
    import('express'),
  ]);
  // CJS-Interop: dynamischer import liefert den Namespace, die Factory
  // steckt in .default (statisches `import express from 'express'` wie in
  // weather.js erledigt diesen Schritt automatisch).
  const express = expressMod.default;
  const app = express();
  app.use('/api/v1/weather', (req, _res, next) => {
    req.authUserId = userId;
    next();
  });
  app.use('/api/v1/weather', buildRouter({
    cfgGet: (key) => (store.has(key) ? store.get(key) : null),
    cfgSet: (key, value) => { store.set(key, value); },
    fetchFn,
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return {
    get: (query = '') => fetch(`http://127.0.0.1:${port}/api/v1/weather${query}`).then((r) => r.json()),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('反编码：城市为空 + DB 坐标 → 返回城市名并持久化 weather_city', { skip: DB_SKIP }, async () => {
  const store = new Map([
    ['weather_provider', 'open-meteo'],
    ['weather_lat', '22.5430'],
    ['weather_lon', '114.0579'],
  ]);
  const { fetchFn, calls } = makeFetch({ geoCity: '深圳市' });
  const app = await serveRouter(store, fetchFn);

  try {
    const body = await app.get('?lang=zh');
    assert.equal(body.data.city, '深圳市');
    // 持久化：家庭键（无个人坐标覆盖时）
    assert.equal(store.get('weather_city'), '深圳市');
    // 恰好一次 Open-Meteo + 一次反编码
    assert.equal(calls.om, 1);
    assert.equal(calls.geo, 1);
    // 语言消毒后的 localityLanguage 进了 URL
    assert.match(calls.geoUrls[0], /localityLanguage=zh/);
  } finally {
    await app.close();
  }
});

test('反编码缓存：第二台 Router（同坐标同语言）零二次 HTTP', { skip: DB_SKIP }, async () => {
  // 第一次：全新 store，反编码走 HTTP 并落库。
  const storeA = new Map([
    ['weather_provider', 'open-meteo'],
    ['weather_lat', '31.2304'],
    ['weather_lon', '121.4737'],
  ]);
  const a = makeFetch({ geoCity: '上海市' });
  const appA = await serveRouter(storeA, a.fetchFn);
  let appB;
  try {
    const first = await appA.get('?lang=zh');
    assert.equal(first.data.city, '上海市');
    assert.equal(storeA.get('weather_city'), '上海市');
    assert.equal(a.calls.geo, 1);

    // 第二次：另一个 Router 实例、另一个 store（没有 weather_city！），
    // 且故意换 units——否则命中 30 分钟天气响应缓存，证明不了反编码缓存。
    const storeB = new Map([
      ['weather_provider', 'open-meteo'],
      ['weather_lat', '31.2304'],
      ['weather_lon', '121.4737'],
      ['weather_units', 'imperial'],
    ]);
    const b = makeFetch({ geoCity: '上海市' });
    appB = await serveRouter(storeB, b.fetchFn);
    const second = await appB.get('?lang=zh');
    assert.equal(second.data.city, '上海市');
    assert.equal(b.calls.om, 1);      // 天气确实重新取了
    assert.equal(b.calls.geo, 0);     // 但反编码没有二次 HTTP
  } finally {
    await appA.close();
    if (appB) await appB.close();
  }
});

test('反编码失败：超时静默回退坐标串，HTTP 200，下次请求重试', { skip: DB_SKIP }, async () => {
  const store = new Map([
    ['weather_provider', 'open-meteo'],
    ['weather_lat', '39.9042'],
    ['weather_lon', '116.4074'],
  ]);
  const { fetchFn, calls } = makeFetch({ geoThrow: true });
  const app = await serveRouter(store, fetchFn);

  try {
    const body = await app.get('?lang=zh');
    // 回退到既有坐标串格式，不白屏不报错
    assert.equal(body.data.city, '39.9042, 116.4074');
    assert.equal(body.data.provider, 'open-meteo');
    // 失败不落库
    assert.equal(store.has('weather_city'), false);
    assert.equal(calls.geo, 1);

    // 失败不缓存：再请求一次会重试（同坐标同单位会命中 Antwort-Cache，
    // 所以换 units 逼出新的上游流程）。
    store.set('weather_units', 'imperial');
    await app.get('?lang=zh');
    assert.equal(calls.geo, 2);
  } finally {
    await app.close();
  }
});

test('反编码失败：5xx 同样回退且不落库', { skip: DB_SKIP }, async () => {
  const store = new Map([
    ['weather_provider', 'open-meteo'],
    ['weather_lat', '48.8566'],
    ['weather_lon', '2.3522'],
  ]);
  const { fetchFn, calls } = makeFetch({ geoCity: null });
  const app = await serveRouter(store, fetchFn);

  try {
    const body = await app.get('?lang=fr');
    assert.equal(body.data.city, '48.8566, 2.3522');
    assert.equal(store.has('weather_city'), false);
    assert.equal(calls.geo, 1);
  } finally {
    await app.close();
  }
});

test('手动城市：零反编码请求', { skip: DB_SKIP }, async () => {
  // 注意坐标与第一条用例不同：回答缓存按 provider|lat|lon|units 键控，
  // 同坐标会命中第一条用例缓存的「深圳市」- 这里就是要验证手填城市短路。
  const store = new Map([
    ['weather_provider', 'open-meteo'],
    ['weather_lat', '23.1291'],
    ['weather_lon', '113.2644'],
    ['weather_city', '北京'],
  ]);
  const { fetchFn, calls } = makeFetch({ geoCity: '广州市' });
  const app = await serveRouter(store, fetchFn);

  try {
    const body = await app.get('?lang=zh');
    assert.equal(body.data.city, '北京');
    assert.equal(calls.geo, 0);
  } finally {
    await app.close();
  }
});

test('个人坐标覆盖：写 weather_city:user:N，家庭键不被污染', { skip: DB_SKIP }, async () => {
  const store = new Map([
    ['weather_provider', 'open-meteo'],
    ['weather_lat:user:7', '30.2741'],
    ['weather_lon:user:7', '120.1551'],
  ]);
  const { fetchFn, calls } = makeFetch({ geoCity: '杭州市' });
  const app = await serveRouter(store, fetchFn, 7);

  try {
    const body = await app.get('?lang=zh');
    assert.equal(body.data.city, '杭州市');
    assert.equal(store.get('weather_city:user:7'), '杭州市');
    assert.equal(store.has('weather_city'), false); // 家庭键干净
    assert.equal(calls.geo, 1);
  } finally {
    await app.close();
  }
});

test('lang 消毒：非法值回落 zh，合法值透传', { skip: DB_SKIP }, async () => {
  // 每条请求一个全新 Router + 全新 store：第一次成功后 weather_city 已
  // 持久化，同一 store 的第二次请求根本不会再反编码（这正是生产的缓存
  // 行为）——语言透传因此用两个独立实例分别验证。
  const bad = makeFetch({ geoCity: 'Berlin' });
  const appBad = await serveRouter(
    new Map([
      ['weather_provider', 'open-meteo'],
      ['weather_lat', '52.5200'],
      ['weather_lon', '13.4050'],
    ]),
    bad.fetchFn,
  );
  let appDe;
  try {
    await appBad.get('?lang=../etc/passwd');
    assert.match(bad.calls.geoUrls[0], /localityLanguage=zh/);

    const de = makeFetch({ geoCity: 'Berlin' });
    appDe = await serveRouter(
      new Map([
        ['weather_provider', 'open-meteo'],
        ['weather_lat', '41.9028'],
        ['weather_lon', '12.4964'],
      ]),
      de.fetchFn,
    );
    await appDe.get('?lang=de-DE');
    assert.match(de.calls.geoUrls[0], /localityLanguage=de/);
  } finally {
    await appBad.close();
    if (appDe) await appDe.close();
  }
});
