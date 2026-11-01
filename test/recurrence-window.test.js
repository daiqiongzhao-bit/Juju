/**
 * 测试：重复事件展开的“老系列”可见性 + 列表分页的工具函数
 *
 * 回归点（本次改动前是真实缺陷，不只是性能问题）：
 *   `expandRecurringEvents()` 从 DTSTART 开始逐次推进，每次一步，靠
 *   MAX_ITER=1000 兜底。一个 2019 年开始的「每天」系列到今天需要 2500 多步，
 *   预算在半路就用完了，循环 break —— 该事件在日历、首页和 ICS 导出里
 *   全部消失。2023 年之前开始的每日系列同样如此。
 *
 *   修复方式：先用 fastForwardOccurrences() 粗跳到窗口前最多一个周期，
 *   剩下的几步仍由原来的循环完成，BYDAY/EXDATE/COUNT/UNTIL 语义不变。
 *
 * 另外覆盖 server/utils/paging.js：limit/offset 的解析与钳制。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fastForwardOccurrences, nextOccurrence, parseRRule } from '../server/services/recurrence.js';
import { parsePaging, pagingMeta, PAGE_DEFAULTS } from '../server/utils/paging.js';
import { expandRecurringEvents } from '../server/services/calendar-events.js';

// ---------------------------------------------------------------------------
// fastForwardOccurrences
// ---------------------------------------------------------------------------

test('fastForwardOccurrences: 每日系列从 2019 跳到窗口前', () => {
  const landed = fastForwardOccurrences('2019-01-01', 'FREQ=DAILY', '2026-11-01');
  assert.ok(landed, '必须返回一个日期');
  assert.ok(landed >= '2019-01-01', '不能早于 DTSTART');
  assert.ok(landed < '2026-11-01', `必须落在窗口之前，实际 ${landed}`);
  // Höchstens eine Periode Abstand — die Feinarbeit macht die normale Schleife.
  assert.equal(landed, '2026-10-31');
});

test('fastForwardOccurrences: 每日系列跳跃后仍落在同一相位上', () => {
  // INTERVAL=3：跳跃结果与 DTSTART 除以 3 的余数必须一致，否则整个
  // 节奏会平移，之后所有实例的日期都错。
  const landed = fastForwardOccurrences('2020-02-01', 'FREQ=DAILY;INTERVAL=3', '2026-11-01');
  assert.ok(landed);
  const base = Date.parse('2020-02-01T00:00:00Z');
  const at   = Date.parse(landed + 'T00:00:00Z');
  assert.equal((at - base) % (3 * 86400000), 0, `${landed} liegt nicht auf dem 3-Tage-Raster`);
});

test('fastForwardOccurrences: 每周系列', () => {
  const landed = fastForwardOccurrences('2019-03-05', 'FREQ=WEEKLY', '2026-11-01');
  assert.ok(landed);
  assert.ok(landed < '2026-11-01');
  // Gleicher Wochentag wie DTSTART (Dienstag).
  assert.equal(new Date(landed + 'T00:00:00Z').getUTCDay(), 2);
});

test('fastForwardOccurrences: COUNT-Serien werden nicht angefasst', () => {
  // Mit COUNT zählt die Expansion ab DTSTART mit; ein Sprung würde die Zählung
  // verfälschen und die Serie vorzeitig beenden.
  assert.equal(fastForwardOccurrences('2019-01-01', 'FREQ=DAILY;COUNT=10', '2026-11-01'), '2019-01-01');
});

test('fastForwardOccurrences: UNTIL vor dem Fenster -> null', () => {
  assert.equal(fastForwardOccurrences('2019-01-01', 'FREQ=DAILY;UNTIL=20200101', '2026-11-01'), null);
});

test('fastForwardOccurrences: MONTHLY/YEARLY bleiben unverändert', () => {
  // Dort sind es pro Jahrhundert nur wenige Hundert Schritte — kein Sonderfall nötig.
  assert.equal(fastForwardOccurrences('2019-01-01', 'FREQ=MONTHLY', '2026-11-01'), '2019-01-01');
  assert.equal(fastForwardOccurrences('2019-01-01', 'FREQ=YEARLY', '2026-11-01'), '2019-01-01');
});

test('fastForwardOccurrences: weniger als eine Periode Abstand -> kein Sprung', () => {
  // Bei einem Tag Abstand gibt es nichts zu überspringen; die Serie beginnt
  // praktisch im Fenster.
  assert.equal(fastForwardOccurrences('2026-10-31', 'FREQ=DAILY', '2026-11-01'), '2026-10-31');
  // Bei sieben Tagen wird gesprungen — das ist unschädlich, weil die Landung
  // vor dem Fenster liegt und die normale Schleife den Rest macht.
  assert.equal(fastForwardOccurrences('2026-10-25', 'FREQ=DAILY', '2026-11-01'), '2026-10-31');
});

test('fastForwardOccurrences: Müll-Eingaben bleiben stehen', () => {
  assert.equal(fastForwardOccurrences('', 'FREQ=DAILY', '2026-11-01'), '');
  assert.equal(fastForwardOccurrences('2019-01-01', 'FREQ=FORTNIGHTLY', '2026-11-01'), '2019-01-01');
  assert.equal(fastForwardOccurrences('2019-01-01', 'FREQ=DAILY', ''), '2019-01-01');
});

test('回归：2019 年开始的每日系列在 1000 步预算内到达窗口', () => {
  // Das ist der eigentliche Bug: Ohne Sprung braucht die Schleife über 2500
  // Schritte und bricht ab, der Termin fehlt im Kalender komplett.
  const from = '2026-11-01';
  const to   = '2027-01-30';
  const rule = 'FREQ=DAILY';

  let current    = '2019-01-01';
  let iterations = 0;
  const MAX_ITER = 1000;

  const skipped = fastForwardOccurrences(current, rule, from);
  assert.ok(skipped && skipped !== current, 'es muss einen Sprung geben');
  current = skipped;

  const hits = [];
  while (current <= to && iterations < MAX_ITER) {
    iterations++;
    if (current >= from) hits.push(current);
    const next = nextOccurrence(current, rule);
    if (!next || next <= current) break;
    current = next;
  }

  assert.ok(iterations < MAX_ITER, `不能把迭代预算用满（${iterations}）`);
  assert.ok(hits.length > 0, '事件必须出现在窗口内');
  assert.equal(hits[0], '2026-11-01');
  assert.equal(hits.at(-1), '2027-01-30');
});

test('COUNT wird geparst und blockiert den Sprung', () => {
  // nextOccurrence() ist zustandslos und kann COUNT nicht durchsetzen — das
  // macht die Expansion. Wichtig hier nur: COUNT ist bekannt und der Sprung
  // unterbleibt, damit die Expansion weiter ab DTSTART zählen kann.
  assert.equal(parseRRule('FREQ=DAILY;COUNT=10').count, 10);
  assert.equal(fastForwardOccurrences('2019-01-01', 'FREQ=DAILY;COUNT=10', '2026-11-01'), '2019-01-01');
});

// ---------------------------------------------------------------------------
// expandRecurringEvents: der eigentliche sichtbare Fehler
// ---------------------------------------------------------------------------

test('expandRecurringEvents: 2019 的每日系列在 2026 的窗口里出现', () => {
  const events = [{
    id: 1,
    title: 'Jeden Tag',
    recurrence_rule: 'FREQ=DAILY',
    start_datetime: '2019-01-01T09:00:00',
    end_datetime: '2019-01-01T10:00:00',
    all_day: 0,
  }];

  const out = expandRecurringEvents(events, '2026-11-01', '2026-11-05');

  assert.equal(out.length, 5, `应该得到 5 个实例，实际 ${out.length}`);
  assert.equal(out[0].start_datetime, '2026-11-01T09:00:00');
  assert.equal(out.at(-1).start_datetime, '2026-11-05T09:00:00');
  // 派生实例必须被标记出来（Nicht-Master），sonst würde die UI sie als
  // eigenständige Termine behandeln.
  assert.equal(out[0].is_recurring_instance, 1);
});

test('expandRecurringEvents: 每周系列同样不再丢', () => {
  const events = [{
    id: 2,
    title: 'Wöchentlich',
    recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU',
    start_datetime: '2019-01-01T18:00:00', // Dienstag
    end_datetime: '2019-01-01T19:00:00',
    all_day: 0,
  }];

  const out = expandRecurringEvents(events, '2026-11-01', '2026-11-30');
  assert.ok(out.length >= 4, `zu wenige Instanzen: ${out.length}`);
  for (const inst of out) {
    assert.equal(new Date(inst.start_datetime.slice(0, 10) + 'T00:00:00Z').getUTCDay(), 2);
  }
});

test('expandRecurringEvents: kurze Serie bleibt unverändert korrekt', () => {
  // Gegenprobe: Der Sprung darf bei einer Serie, die im Fenster beginnt,
  // nichts verändern.
  const events = [{
    id: 3,
    title: 'Neu',
    recurrence_rule: 'FREQ=DAILY',
    start_datetime: '2026-11-02T08:00:00',
    end_datetime: '2026-11-02T09:00:00',
    all_day: 0,
  }];

  const out = expandRecurringEvents(events, '2026-11-01', '2026-11-04');
  assert.deepEqual(out.map((e) => e.start_datetime), [
    '2026-11-02T08:00:00',
    '2026-11-03T08:00:00',
    '2026-11-04T08:00:00',
  ]);
});

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

test('parsePaging: ohne Parameter gilt die Vorgabe', () => {
  const p = parsePaging({}, PAGE_DEFAULTS.notes);
  assert.deepEqual(p, { limit: PAGE_DEFAULTS.notes.defaultLimit, offset: 0, explicit: false });
});

test('parsePaging: limit und offset werden gelesen', () => {
  const p = parsePaging({ limit: '25', offset: '50' }, PAGE_DEFAULTS.notes);
  assert.deepEqual(p, { limit: 25, offset: 50, explicit: true });
});

test('parsePaging: limit wird auf maxLimit geklemmt', () => {
  const p = parsePaging({ limit: '999999' }, PAGE_DEFAULTS.notes);
  assert.equal(p.limit, PAGE_DEFAULTS.notes.maxLimit);
});

test('parsePaging: negative und unsinnige Werte fallen auf sinnvolle Defaults', () => {
  assert.equal(parsePaging({ limit: '-5' }, PAGE_DEFAULTS.notes).limit, 1);
  assert.equal(parsePaging({ offset: '-5' }, PAGE_DEFAULTS.notes).offset, 0);
  assert.equal(parsePaging({ limit: 'abc' }, PAGE_DEFAULTS.notes).limit, PAGE_DEFAULTS.notes.defaultLimit);
});

test('pagingMeta: has_more', () => {
  const paging = { limit: 10, offset: 0, explicit: true };
  assert.equal(pagingMeta(paging, true).has_more, true);
  assert.equal(pagingMeta(paging, false).has_more, false);
});
