/**
 * 测试：AI 模型清单动态拉取（server/services/ai-models.js 的 listProviderModels）
 *
 * 覆盖（需求 §4）：
 *   1. 无配置 / 无 key  → NO_CONFIG 或 NO_KEY
 *   2. mock fetch 成功  → 返回按 id 升序排序的模型数组
 *   3. mock fetch 401/403 → AUTH_FAILED
 *   4. mock fetch 超时 / 网络错误 / 5xx / 非预期形状 → UPSTREAM_ERROR
 *   5. provider=doubao → UNSUPPORTED_PROVIDER 且不调用 fetch
 *
 * 设计：listProviderModels 只依赖全局 fetch / AbortController，不读库，因此直接
 * 单测该函数即可（与项目「服务层直接测」的约定一致，零依赖、无需起服务）。
 * 通过替换 globalThis.fetch 注入不同上游行为。
 *
 * 安全守卫：返回的包络不得携带明文 key，message 不得包含密钥。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { listProviderModels } from '../server/services/ai-models.js';

const REAL_FETCH = globalThis.fetch;

/** 用提供的实现替换全局 fetch，并返回还原函数。 */
function mockFetch(impl) {
  globalThis.fetch = impl;
  return () => { globalThis.fetch = REAL_FETCH; };
}

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function failResponse(status, body = {}) {
  return {
    ok: false,
    status,
    json: async () => body,
  };
}

test('无配置/无 key → NO_KEY（空配置缺 key）', () => {
  const restore = mockFetch(async () => { throw new Error('fetch must not be called'); });
  try {
    const res = listProviderModels({ provider: 'openai', baseUrl: null, apiKey: null });
    return res.then((r) => {
      assert.equal(r.ok, false);
      assert.ok(['NO_KEY', 'NO_CONFIG'].includes(r.code), `期望 NO_KEY/NO_CONFIG，实际 ${r.code}`);
    });
  } finally {
    restore();
  }
});

test('无可用 Base URL（custom 且留空）→ NO_CONFIG', () => {
  const restore = mockFetch(async () => { throw new Error('fetch must not be called'); });
  try {
    const res = listProviderModels({ provider: 'custom', baseUrl: '', apiKey: 'sk-test' });
    return res.then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'NO_CONFIG');
    });
  } finally {
    restore();
  }
});

test('mock fetch 成功 → 返回按 id 升序排序的模型数组', () => {
  const restore = mockFetch(async () => okResponse({
    data: [{ id: 'gpt-4o' }, { id: 'gpt-3.5-turbo' }, { id: 'gpt-4' }],
  }));
  try {
    const res = listProviderModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
    return res.then((r) => {
      assert.equal(r.ok, true);
      assert.deepEqual(r.models, ['gpt-3.5-turbo', 'gpt-4', 'gpt-4o']);
      assert.equal(r.provider, 'openai');
    });
  } finally {
    restore();
  }
});

test('mock fetch 成功 → 过滤非法条目并排序', () => {
  const restore = mockFetch(async () => okResponse({
    data: [{ id: 'b' }, {}, { id: '' }, { id: 'a' }, { foo: 'x' }],
  }));
  try {
    const res = listProviderModels({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test' });
    return res.then((r) => {
      assert.equal(r.ok, true);
      assert.deepEqual(r.models, ['a', 'b']);
    });
  } finally {
    restore();
  }
});

test('mock fetch 401 → AUTH_FAILED', () => {
  const restore = mockFetch(async () => failResponse(401, { error: 'invalid_api_key' }));
  try {
    const res = listProviderModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
    return res.then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'AUTH_FAILED');
    });
  } finally {
    restore();
  }
});

test('mock fetch 403 → AUTH_FAILED（401/403 区分出鉴权失败）', () => {
  const restore = mockFetch(async () => failResponse(403, { error: 'forbidden' }));
  try {
    const res = listProviderModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
    return res.then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'AUTH_FAILED');
    });
  } finally {
    restore();
  }
});

test('mock fetch 5xx → UPSTREAM_ERROR', () => {
  const restore = mockFetch(async () => failResponse(500, { error: 'boom' }));
  try {
    const res = listProviderModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
    return res.then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'UPSTREAM_ERROR');
    });
  } finally {
    restore();
  }
});

test('mock fetch 返回非预期形状（data 非数组）→ UPSTREAM_ERROR', () => {
  const restore = mockFetch(async () => okResponse({ models: ['x'] }));
  try {
    const res = listProviderModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
    return res.then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'UPSTREAM_ERROR');
    });
  } finally {
    restore();
  }
});

test('mock fetch 返回非 JSON → UPSTREAM_ERROR', () => {
  const restore = mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error('not json'); },
  }));
  try {
    const res = listProviderModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
    return res.then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'UPSTREAM_ERROR');
    });
  } finally {
    restore();
  }
});

test('mock fetch 抛网络错误 → UPSTREAM_ERROR', () => {
  const restore = mockFetch(async () => { throw new Error('network down'); });
  try {
    const res = listProviderModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
    return res.then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'UPSTREAM_ERROR');
    });
  } finally {
    restore();
  }
});

test('mock fetch 超时（AbortError）→ UPSTREAM_ERROR', () => {
  const restore = mockFetch(async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });
  try {
    const res = listProviderModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
    return res.then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'UPSTREAM_ERROR');
    });
  } finally {
    restore();
  }
});

test('provider=doubao → UNSUPPORTED_PROVIDER 且不调用 fetch', () => {
  let called = false;
  const restore = mockFetch(async () => { called = true; throw new Error('fetch must not be called for doubao'); });
  try {
    const res = listProviderModels({ provider: 'doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'sk-test' });
    return res.then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'UNSUPPORTED_PROVIDER');
      assert.equal(called, false, 'doubao 不应发起 /models 请求');
    });
  } finally {
    restore();
  }
});

test('安全守卫：返回包络不含明文 key，message 不泄漏密钥', () => {
  const secret = 'sk-super-secret-tail42';
  const restore = mockFetch(async () => okResponse({ data: [{ id: 'm1' }] }));
  try {
    const res = listProviderModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: secret });
    return res.then((r) => {
      assert.ok(!('apiKey' in r), '包络不得带 apiKey 字段');
      assert.ok(!JSON.stringify(r).includes(secret), '响应序列化后不得出现明文 key');
    });
  } finally {
    restore();
  }
});
