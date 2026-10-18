/**
 * 测试：CSV/JSON 解析 + 列映射（批次三「通用导入工具」的纯函数层）
 *
 * 覆盖：引号内分隔符/换行/转义双引号、BOM、CRLF/CR/LF、分隔符自动识别、
 *       JSON 记录的三种形态、表头自动对齐（中英德别名）、日期/时间/枚举
 *       归一化的合法与非法输入。
 *
 * 说明：这一层刻意不碰数据库（解析与写库是两件事），因此在 Node 20 上也能
 *       全量运行 —— 不需要 Node 22 的 better-sqlite3。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stripBom,
  detectDelimiter,
  parseCsv,
  parseCsvDetailed,
  rowsToRecords,
  parseJsonRecords,
} from '../server/services/import-csv.js';

import {
  IMPORT_MODULES,
  getImportModule,
  listImportModules,
  autoMapHeaders,
  buildRecords,
  coerceField,
  normalizeDate,
  normalizeTime,
  normalizeNumber,
} from '../server/services/import-mapping.js';

test('stripBom: 去掉 UTF-8 BOM，无 BOM 原样返回', () => {
  assert.equal(stripBom('﻿a,b'), 'a,b');
  assert.equal(stripBom('a,b'), 'a,b');
});

test('detectDelimiter: 逗号/分号/制表符/竖线按首行频率择优', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
  assert.equal(detectDelimiter('a|b|c'), '|');
  // 单列文件没有分隔符信息 -> 回退逗号
  assert.equal(detectDelimiter('only-one-column'), ',');
});

test('parseCsv: 简单表格按行列切分', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('parseCsv: 引号内的逗号不切列', () => {
  const rows = parseCsv('name,note\n"Müller, Anna","ruft an"\nBen,');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0], 'Müller, Anna');
  assert.equal(rows[1][1], 'ruft an');
});

test('parseCsv: 引号内的换行保留在同一单元格', () => {
  const rows = parseCsv('title,notes\n"Einkauf","Brot\nMilch\nEier"');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 'Brot\nMilch\nEier');
});

test('parseCsv: 转义双引号 "" 还原为单个引号', () => {
  const rows = parseCsv('note\n"er sagte ""Hallo"""');
  assert.equal(rows[1][0], 'er sagte "Hallo"');
});

test('parseCsv: BOM + CRLF + 末尾换行都处理干净', () => {
  const rows = parseCsv('﻿a,b\r\n1,2\r\n3,4\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('parseCsv: 裸 CR（老 Mac 导出行尾）也算换行', () => {
  assert.deepEqual(parseCsv('a,b\r1,2'), [['a', 'b'], ['1', '2']]);
});

test('parseCsv: 空列保留为空字符串，尾部空行不入结果', () => {
  assert.deepEqual(parseCsv('a,,c\n1,,3'), [['a', '', 'c'], ['1', '', '3']]);
});

test('parseCsvDetailed: 显式分隔符优先于自动识别', () => {
  const result = parseCsvDetailed('a;b,c', { delimiter: ';' });
  assert.equal(result.delimiter, ';');
  assert.deepEqual(result.rows, [['a', 'b,c']]);
});

test('parseCsv: 非法输入不抛错（返回空行集）', () => {
  assert.deepEqual(parseCsv(null), []);
  assert.deepEqual(parseCsv(undefined), []);
  assert.deepEqual(parseCsv(''), []);
});

test('rowsToRecords: 有表头时生成对象数组，无表头退化为 column_N', () => {
  const withHeader = rowsToRecords([['a', 'b'], ['1', '2']], { hasHeader: true });
  assert.deepEqual(withHeader.headers, ['a', 'b']);
  assert.deepEqual(withHeader.records, [{ a: '1', b: '2' }]);

  const noHeader = rowsToRecords([['1', '2']], { hasHeader: false });
  assert.deepEqual(noHeader.headers, ['column_1', 'column_2']);
  assert.deepEqual(noHeader.records, [{ column_1: '1', column_2: '2' }]);
});

test('parseJsonRecords: 数组 / data 包裹 / results 包裹都能取出记录', () => {
  assert.deepEqual(parseJsonRecords('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(parseJsonRecords('{"data":[{"a":1},{"a":2}]}'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseJsonRecords('{"results":[{"a":1}]}'), [{ a: 1 }]);
});

test('parseJsonRecords: 非法 JSON 返回 null（由调用方降级，不抛错）', () => {
  assert.equal(parseJsonRecords('not json'), null);
  assert.equal(parseJsonRecords(''), null);
  // 合法 JSON 但不是对象数组（例如单个对象无 data/items 键）→ null
  assert.equal(parseJsonRecords('{"foo":1}'), null);
});

test('IMPORT_MODULES: 四个模块齐备，且每个都有必填字段与别名', () => {
  const keys = IMPORT_MODULES.map((mod) => mod.key);
  assert.deepEqual(keys, ['tasks', 'contacts', 'shopping', 'recipes']);
  for (const mod of IMPORT_MODULES) {
    assert.ok(mod.fields.length > 0, `${mod.key} 应至少有字段定义`);
    assert.ok(mod.fields.some((field) => field.required), `${mod.key} 应有必填字段`);
    for (const field of mod.fields) {
      assert.ok(Array.isArray(field.aliases) && field.aliases.length > 0, `${mod.key}.${field.key} 缺别名`);
    }
  }
  assert.equal(getImportModule('tasks')?.table, 'tasks');
  assert.equal(getImportModule('nope'), null);
});

test('listImportModules: 返回可 JSON 序列化的精简视图（不含别名）', () => {
  const list = listImportModules();
  assert.equal(list.length, IMPORT_MODULES.length);
  for (const entry of list) {
    assert.equal(typeof entry.hint, 'string');
    assert.ok(!('aliases' in entry));
  }
  // 深拷贝安全（测试里的模块本质相同）
  assert.doesNotThrow(() => JSON.stringify(list));
});

test('autoMapHeaders: 英文表头自动对齐', () => {
  const { mapping, unmatched } = autoMapHeaders('tasks', ['Title', 'Due Date', 'Priority', 'Notes']);
  assert.equal(mapping.title, 0);
  assert.equal(mapping.due_date, 1);
  assert.equal(mapping.priority, 2);
  assert.equal(mapping.description, 3);
  assert.deepEqual(unmatched, []);
});

test('autoMapHeaders: 中文表头（飞书/备忘录导出）也能对齐', () => {
  const { mapping } = autoMapHeaders('contacts', ['姓名', '手机', '邮箱', '备注']);
  assert.equal(mapping.name, 0);
  assert.equal(mapping.phone, 1);
  assert.equal(mapping.email, 2);
  assert.equal(mapping.notes, 3);
});

test('autoMapHeaders: 同一目标字段只认第一次命中，后续列留给 unmatched', () => {
  const { mapping, unmatched } = autoMapHeaders('tasks', ['Title', 'Task']);
  assert.equal(mapping.title, 0);
  assert.deepEqual(unmatched, ['Task']);
});

test('normalizeDate: ISO / 斜杠 / 中文年月日 / 紧凑格式都能归一', () => {
  assert.equal(normalizeDate('2026-04-01'), '2026-04-01');
  assert.equal(normalizeDate('2026-04-01T10:00:00Z'), '2026-04-01');
  assert.equal(normalizeDate('2026/4/1'), '2026-04-01');
  assert.equal(normalizeDate('01.04.2026'), '2026-04-01');
  assert.equal(normalizeDate('2026年4月1日'), '2026-04-01');
  assert.equal(normalizeDate('20260401'), '2026-04-01');
  assert.equal(normalizeDate(''), null);
});

test('normalizeDate: 不存在的日期（2 月 31 日）判为非法', () => {
  assert.equal(normalizeDate('2026-02-31'), null);
  assert.equal(normalizeDate('2026-13-01'), null);
  assert.equal(normalizeDate('kein Datum'), null);
});

test('normalizeTime: 24 小时制、12 小时制、空值三种结果', () => {
  assert.deepEqual(normalizeTime('09:30'), { ok: true, value: '09:30' });
  assert.deepEqual(normalizeTime('9:05:00'), { ok: true, value: '09:05' });
  assert.deepEqual(normalizeTime('2:30 pm'), { ok: true, value: '14:30' });
  assert.deepEqual(normalizeTime('12:00 am'), { ok: true, value: '00:00' });
  assert.deepEqual(normalizeTime(''), { ok: true, value: null });
  assert.equal(normalizeTime('morgen').ok, false);
  assert.equal(normalizeTime('25:00').ok, false);
});

test('normalizeNumber: 「3 人份」这类半结构化文本取数字，负数拒绝', () => {
  assert.deepEqual(normalizeNumber('4'), { ok: true, value: 4 });
  assert.deepEqual(normalizeNumber('3 人份'), { ok: true, value: 3 });
  assert.deepEqual(normalizeNumber(''), { ok: true, value: null });
  assert.equal(normalizeNumber('viele').ok, false);
});

test('coerceField: 枚举字段接受德语/中文别名，未知取值判失败', () => {
  const priority = getImportModule('tasks').fields.find((f) => f.key === 'priority');
  assert.deepEqual(coerceField(priority, 'hoch'), { ok: true, value: 'high' });
  assert.deepEqual(coerceField(priority, 'urgent'), { ok: true, value: 'urgent' });
  assert.deepEqual(coerceField(priority, ''), { ok: true, value: null });
  assert.equal(coerceField(priority, 'bitte-schnell').ok, false);

  const status = getImportModule('tasks').fields.find((f) => f.key === 'status');
  assert.deepEqual(coerceField(status, 'erledigt'), { ok: true, value: 'done' });
  assert.deepEqual(coerceField(status, 'In Progress'), { ok: true, value: 'in_progress' });
});

test('coerceField: 超长文本按上限截断而不是报错', () => {
  const title = getImportModule('tasks').fields.find((f) => f.key === 'title');
  const result = coerceField(title, 'x'.repeat(500));
  assert.equal(result.ok, true);
  assert.equal(result.value.length, title.max);
});

test('buildRecords: 必填缺失与非法日期分别逐行报错，不牵连其他行', () => {
  const rows = [
    { cells: ['Müll raus', '2026-04-01', 'high'], rowNumber: 2 },
    { cells: ['', '2026-04-02', 'low'], rowNumber: 3 },          // 标题缺失
    { cells: ['Kaputt', '31.02.2026', 'high'], rowNumber: 4 },   // 日期非法
    { cells: ['Ok', '', ''], rowNumber: 5 },
  ];
  const records = buildRecords('tasks', rows, { title: 0, due_date: 1, priority: 2 });

  assert.equal(records.length, 4);
  assert.deepEqual(records[0].errors, []);
  assert.equal(records[0].record.title, 'Müll raus');
  assert.equal(records[0].record.due_date, '2026-04-01');
  assert.match(records[1].errors.join(';'), /required/i);
  assert.match(records[2].errors.join(';'), /invalid date/i);
  assert.deepEqual(records[3].errors, []);
});

test('buildRecords: 未映射的列被忽略（不做猜测式搬运）', () => {
  const records = buildRecords('tasks', [{ cells: ['Nur Titel'], rowNumber: 2 }], { title: 0 });
  assert.deepEqual(records[0].record, { title: 'Nur Titel' });
});
