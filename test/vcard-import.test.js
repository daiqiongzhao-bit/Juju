/**
 * 测试：vCard 批量导入解析（server/services/vcard-import.js，T5）
 *
 * 覆盖：
 *   1) vCard 3.0 / 4.0 多卡文本：splitVCards 切块数量正确，N 结构化姓名
 *      组装 display name，FN 仅作 fallback。
 *   2) Quoted-Printable（vCard 2.1 遗产）：含软换行（=` 行尾）的多字节
 *      UTF-8 序列正确解码（如 =E5=BC=A0 → 「张」）。
 *   3) BDAY → ISO 日期：YYYY-MM-DD / YYYYMMDD / 纯年份 / 带时区垃圾 后缀。
 *   4) CATEGORIES → category：多值取第一段；fallbackCategory 兜底。
 *   5) vcardToContactTable：表头 = contacts 模块字段 key，行与表头对齐。
 *
 * 纯函数测试，不触数据库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'error';

const {
  splitVCards,
  parseVCard,
  parseVCards,
  parseBirthdayValue,
  vcardToContactTable,
} = await import('../server/services/vcard-import.js');

const TWO_CARDS_V3 = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:张;三;;;',
  'FN:张三',
  'TEL:+86 138 0013 8000',
  'EMAIL:zhang@example.com',
  'ADR:;;示例路 1 号;北京市;;100000;中国',
  'ORG:示例公司;研发部',
  'TITLE:工程师',
  'NICKNAME:小张',
  'NOTE:备注第一行\\n备注第二行',
  'BDAY:1990-05-09',
  'CATEGORIES:Friends,Work',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Jane Doe',
  'TEL:+49 30 123456',
  'END:VCARD',
  '',
].join('\r\n');

test('vCard 3.0 多卡：切块数量与字段解析', () => {
  const cards = splitVCards(TWO_CARDS_V3);
  assert.equal(cards.length, 2, '两张卡应切成两个块');

  const [first] = parseVCards(TWO_CARDS_V3);
  // N 结构化姓名优先（#535），显示名恒为 `名 中间 姓`（composeDisplayName 设计）。
  assert.equal(first.name, '张三'); // 中文姓名：姓+名，无空格
  assert.equal(first.phone, '+86 138 0013 8000');
  assert.equal(first.email, 'zhang@example.com');
  assert.equal(first.birthday, '1990-05-09');
  assert.equal(first.organization, '示例公司', 'ORG 取第一段（公司），部门不进导入字段');
  assert.equal(first.job_title, '工程师');
  assert.equal(first.nickname, '小张');
  assert.ok(first.address?.includes('示例路 1 号'), 'ADR 街道应进入 address');
  assert.ok(first.notes?.includes('\n'), 'vCard 转义 \\n 应解为换行');

  const second = parseVCards(TWO_CARDS_V3)[1];
  assert.equal(second.name, 'Jane Doe', '无 N 时 FN 作为 fallback');
  assert.equal(second.birthday, null, '缺失 BDAY 为 null 而非报错');
});

test('Quoted-Printable：软换行 + 多字节 UTF-8 正确解码', () => {
  // 张三 = E5BCA0 E4B889，拆在软换行两侧。
  const qpCard = [
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E5=BC=A0=',
    ' =E4=B8=89;;;',
    'TEL:+86 139 0000 0000',
    'END:VCARD',
    '',
  ].join('\r\n');

  const card = parseVCard(qpCard);
  // QP 两个多字节字符都正确解码；显示名按 composeDisplayName 规则为「名 姓」。
  assert.equal(card.name, '张 三', 'QP 序列跨软换行应拼回同一字符');
  assert.equal(card.phone, '+86 139 0000 0000');
});

test('BDAY 规范化为 ISO：紧凑 / 纯年份 / 带垃圾后缀 / 非法', () => {
  assert.equal(parseBirthdayValue('1990-05-09'), '1990-05-09');
  assert.equal(parseBirthdayValue('19900509'), '1990-05-09');
  assert.equal(parseBirthdayValue('1990'), '1990-01-01', '纯年份补 01-01');
  // 带时区后缀的 date-time 剥掉非 [0-9-] 后变 `1990-05-090000`，不匹配任何
  // 模式 → null（与 cardav-sync / 前端 public/utils/vcard.js 行为一致）。
  assert.equal(parseBirthdayValue('1990-05-09T00:00:00Z'), null, 'date-time 形式不可用 → null');
  assert.equal(parseBirthdayValue('not-a-date'), null);
  assert.equal(parseBirthdayValue(''), null);
  assert.equal(parseBirthdayValue(null), null);
});

test('CATEGORIES → category：多值取第一段，fallback 兜底', () => {
  const withCat = parseVCard(TWO_CARDS_V3.split('END:VCARD')[0] + 'END:VCARD');
  assert.equal(withCat.category, 'Friends');

  // 无 CATEGORIES → fallbackCategory。
  const bare = [
    'BEGIN:VCARD',
    'VERSION:4.0',
    'FN:No Category',
    'END:VCARD',
  ].join('\r\n');
  assert.equal(parseVCard(bare).category, 'misc');
  assert.equal(parseVCard(bare, { fallbackCategory: 'family' }).category, 'family');
  // vCard 4.0 同样吃得下（VERSION 行不参与解析，属性驱动）。
  assert.equal(parseVCard(bare).name, 'No Category');
});

test('vcardToContactTable：表头 = contacts 字段 key，行列对齐', () => {
  const table = vcardToContactTable(TWO_CARDS_V3);
  assert.deepEqual(table.headers, [
    'name', 'category', 'phone', 'email', 'address',
    'notes', 'birthday', 'organization', 'job_title', 'nickname',
  ]);
  assert.equal(table.rows.length, 2);
  const nameIdx = table.headers.indexOf('name');
  const phoneIdx = table.headers.indexOf('phone');
  const birthdayIdx = table.headers.indexOf('birthday');
  assert.equal(table.rows[0][nameIdx], '张三');
  assert.equal(table.rows[0][phoneIdx], '+86 138 0013 8000');
  assert.equal(table.rows[0][birthdayIdx], '1990-05-09');
  assert.equal(table.rows[1][nameIdx], 'Jane Doe');
  assert.equal(table.rows[1][birthdayIdx], '', '缺失字段为空串（与 CSV 提取一致）');
});
