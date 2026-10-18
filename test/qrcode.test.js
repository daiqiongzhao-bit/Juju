/**
 * 测试：QR 码生成（server/utils/qrcode.js）
 *
 * 覆盖：SVG 结构合法性、模块矩阵尺寸、定位/校正/时序图形、同输入可重复、
 *       不同输入不同输出、版本随长度增长、超长输入抛错。纯内存，无外部依赖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { qrMatrix, qrSvg } from '../server/utils/qrcode.js';

test('qrSvg: 输出合法的、自包含的 SVG 片段', () => {
  const svg = qrSvg('otpauth://totp/Juju:alice?secret=GEZDGNBVGY3TQOJQ');

  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), '必须是 SVG 根元素');
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(svg.includes('viewBox="0 0 '));
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
  assert.ok(svg.includes('<g fill="#111827">'));
  assert.ok(svg.includes('<rect'), '至少需要一个模块方块');
  // 不得引用外部资源或脚本（要能安全地嵌进 HTML 模板）。
  assert.ok(!/<script/i.test(svg));
  assert.ok(!/href=|xlink:|url\(/.test(svg));
});

test('qrSvg: 尺寸 = (模块数 + 2*边距) * 模块像素，且可配置', () => {
  const text = 'HELLO WORLD';
  const { size } = qrMatrix(text);

  const svg = qrSvg(text, { moduleSize: 5, margin: 4 });
  const expected = (size + 8) * 5;
  assert.ok(svg.includes(`viewBox="0 0 ${expected} ${expected}"`), svg.slice(0, 120));
  assert.ok(svg.includes(`width="${expected}"`));
  assert.ok(svg.includes(`height="${expected}"`));

  // 自定义前景/背景色必须出现在输出里。
  const colored = qrSvg(text, { dark: '#000000', light: '#fafafa' });
  assert.ok(colored.includes('fill="#fafafa"'));
  assert.ok(colored.includes('<g fill="#000000">'));
});

test('qrMatrix: 版本 1 为 21×21，尺寸随版本线性增长', () => {
  const { modules, size, version } = qrMatrix('HI');

  assert.equal(version, 1);
  assert.equal(size, 21);
  assert.equal(modules.length, size);
  for (const row of modules) assert.equal(row.length, size);

  const bigger = qrMatrix('x'.repeat(120));
  assert.ok(bigger.version > version, '内容更长时应使用更高版本');
  assert.equal(bigger.size, 17 + 4 * bigger.version);
});

test('qrMatrix: 三个定位图形（左上/右上/左下）形状正确', () => {
  const { modules, size } = qrMatrix('finder-pattern');

  // 左上 7×7：外框全黑，内圈 3×3 黑，中间环白。
  for (let i = 0; i < 7; i++) {
    assert.equal(modules[0][i], true, `第 0 行第 ${i} 列应为黑`);
    assert.equal(modules[6][i], true);
    assert.equal(modules[i][0], true);
    assert.equal(modules[i][6], true);
  }
  assert.equal(modules[1][1], false);
  assert.equal(modules[2][2], true);

  // 分隔带：定位图形外侧必须留白。
  assert.equal(modules[7][7], false);

  // 右上与左下角各有一个定位图形。
  assert.equal(modules[0][size - 1], true);
  assert.equal(modules[0][size - 7], true);
  assert.equal(modules[size - 1][0], true);
  assert.equal(modules[size - 7][0], true);
});

test('qrMatrix: 时序图形按奇偶交替', () => {
  const { modules, size } = qrMatrix('timing-pattern');

  for (let i = 8; i <= size - 9; i++) {
    assert.equal(modules[6][i], i % 2 === 0, `第 6 行第 ${i} 列应为${i % 2 === 0 ? '黑' : '白'}`);
    assert.equal(modules[i][6], i % 2 === 0, `第 6 列第 ${i} 行应为${i % 2 === 0 ? '黑' : '白'}`);
  }
});

test('qrMatrix: 同输入可重复，异输入不同', () => {
  const first = qrMatrix('same-input');
  const second = qrMatrix('same-input');
  assert.deepEqual(first.modules, second.modules);

  const other = qrMatrix('other-input');
  assert.notDeepEqual(first.modules, other.modules);
});

test('qrSvg: 空串与最大容量输入都在支持范围内', () => {
  assert.ok(qrSvg('').startsWith('<svg'));
  assert.ok(qrSvg('x'.repeat(200)).startsWith('<svg'));
});

test('qrSvg: 超出最大版本容量时明确抛错', () => {
  assert.throws(() => qrSvg('x'.repeat(400)), /Input too long for QR version/);
  assert.throws(() => qrMatrix('x'.repeat(4000)), /Input too long for QR version/);
});

test('端到端：otpauth URI（2FA 场景真实长度）能编码成稳定 SVG', () => {
  const uri =
    'otpauth://totp/Juju:alice@example.com?' +
    'secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Juju&algorithm=SHA1&digits=6&period=30';

  const svg = qrSvg(uri, { moduleSize: 5, margin: 4 });
  assert.ok(svg.startsWith('<svg'));
  assert.equal(qrSvg(uri, { moduleSize: 5, margin: 4 }), svg);
  // 变长内容应给出不同的矩阵（URI 确实被编进了码里）。
  assert.notEqual(svg, qrSvg(`${uri}&extra=1`));
});
