/**
 * 测试：GET /api/v1/import/template（T6b）+ vCard 走 /preview 的 autoMap 1:1（T6a）
 *
 * 覆盖：
 *   1) ?module=contacts 返回 text/csv 附件，首行 = CONTACT_FIELDS 顺序的表头
 *      （name,category,phone,...），且 autoMapHeaders 对模板表头全量命中。
 *   2) 未知 module → 400。
 *   3) format=vcard 的 /preview：vcardToContactTable 产出的表头与 contacts
 *      字段一一对应，mapping 不留 unmatched（联系人导入无需手动重排列）。
 *
 * 路由层测试：requireAdmin 只看 req.authRole —— 挂一个置位中间件即可，
 * 不需要真实会话（见 server/middleware/require-admin.js 的无副作用设计）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'juju-import-template-')), 'test.db');
process.env.LOG_LEVEL = 'error';
process.env.SESSION_SECRET = 'test-secret-for-import-template';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const SKIP = NODE_MAJOR >= 22 ? false : `better-sqlite3-multiple-ciphers 需要 Node >= 22（当前 v${process.versions.node}）`;

let baseUrl = null;

/** 起一次性的 express 实例：admin 直通 + import 路由。 */
async function setup() {
  if (baseUrl) return;
  const [expressMod, { default: importRouter }] = await Promise.all([
    import('express'),
    import('../server/routes/import.js'),
  ]);
  const express = expressMod.default;
  const app = express();
  app.use(express.json());
  // 测试直通：模拟已认证的管理员（requireAdmin 仅检查 req.authRole）。
  app.use((_req, _res, next) => { _req.authRole = 'admin'; next(); });
  app.use('/api/v1/import', importRouter);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  // 不阻塞测试进程退出（node:test 进程结束时端口自动释放）。
  server.unref();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test('GET /template?module=contacts 返回 text/csv，首行为 CONTACT_FIELDS 顺序表头', async () => {
  if (SKIP) return test.skip(SKIP);
  await setup();

  const res = await fetch(`${baseUrl}/api/v1/import/template?module=contacts`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/csv/i);

  const csv = await res.text();
  const firstLine = csv.split(/\r?\n/)[0];
  assert.equal(
    firstLine,
    'name,category,phone,email,address,notes,birthday,organization,job_title,nickname',
    '模板表头必须是 CONTACT_FIELDS 的 key 顺序（autoMapHeaders 1:1 命中的前提）',
  );

  // 模板自带 1 行示例数据。
  const lines = csv.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 2, '模板应包含表头 + 示例行');
});

test('未知 module 返回 400', async () => {
  if (SKIP) return test.skip(SKIP);
  await setup();

  const res = await fetch(`${baseUrl}/api/v1/import/template?module=nonexistent`);
  assert.equal(res.status, 400);
});

test('POST /preview（format=vcard）：表头 1:1 命中，mapping 无 unmatched', async () => {
  if (SKIP) return test.skip(SKIP);
  await setup();

  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:张;三;;;',
    'FN:张三',
    'TEL:+86 138 0013 8000',
    'EMAIL:zhang@example.com',
    'BDAY:1990-05-09',
    'END:VCARD',
    '',
  ].join('\r\n');

  const res = await fetch(`${baseUrl}/api/v1/import/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ module: 'contacts', format: 'vcard', content: vcard }),
  });
  assert.equal(res.status, 200);

  const { data } = await res.json();
  assert.equal(data.format, 'vcard');
  assert.equal(data.totalRows, 1);
  // vcardToContactTable 的表头 = CONTACT_FIELDS keys → 全量命中、零 unmatched。
  assert.deepEqual(
    Object.keys(data.mapping).sort(),
    ['address', 'birthday', 'category', 'email', 'job_title', 'name', 'nickname', 'notes', 'organization', 'phone'],
  );
  assert.equal(data.mapping.name, 0, 'name 列应映射到第 0 列');
});
