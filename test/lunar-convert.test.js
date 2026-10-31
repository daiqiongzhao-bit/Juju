/**
 * 测试：农历换算 deriveFromLunar / deriveLunarFields / leapMonthOf
 *
 * 覆盖：
 *   1) 农历 → 公历正算：农历 1990-四月-15 → 公历 1990-05-09（马年、金牛座），
 *      期望值用 lunar-javascript 独立实算锚定，而非拍脑袋。
 *   2) 闰月：2020 年闰四月（leapMonthOf(2020) === 4），农历 2020-闰四月-15 →
 *      公历 2020-06-06，birthdayLunar 记 `2020-L04-15`；且与公历反算闭环。
 *   3) 越界与非法入参：年 1899/2101、月 13、日 31、无闰月年份强行闰月
 *      （2021 年无闰月）→ 一律返回 null。
 *
 * 纯函数测试，不触数据库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Lunar, LunarYear } from 'lunar-javascript';

process.env.LOG_LEVEL = 'error';

const { deriveFromLunar, deriveLunarFields, leapMonthOf } = await import('../server/services/lunar-fields.js');

test('农历 1990-4-15 正算为公历 1990-05-09，生肖马、金牛座', () => {
  // 库内实算锚点（与断言独立核对）：
  assert.equal(Lunar.fromYmd(1990, 4, 15).getSolar().toYmd(), '1990-05-09');

  const result = deriveFromLunar(1990, 4, 15);
  assert.ok(result, 'deriveFromLunar 应返回结果而非 null');
  assert.equal(result.birthday, '1990-05-09');
  assert.equal(result.birthdayLunar, '1990-04-15');
  assert.equal(result.zodiac, '马');
  assert.equal(result.constellation, '金牛座');
});

test('2020 闰四月：leapMonthOf=4，闰四月十五 → 2020-06-06，记 2020-L04-15', () => {
  assert.equal(leapMonthOf(2020), 4);
  assert.equal(Lunar.fromYmd(2020, -4, 15).getSolar().toYmd(), '2020-06-06');

  const result = deriveFromLunar(2020, 4, 15, true);
  assert.ok(result, '合法闰月日期应换算成功');
  assert.equal(result.birthday, '2020-06-06');
  assert.equal(result.birthdayLunar, '2020-L04-15');
  assert.equal(result.constellation, '双子座');
});

test('闰月标记与非闰月同月不同日：公历反算闭环一致', () => {
  // 公历 2020-06-05 落在闰四月十四 —— deriveLunarFields 应记 L 前缀。
  const derived = deriveLunarFields('2020-06-05');
  assert.equal(derived.birthdayLunar, '2020-L04-14');
  // 且 deriveFromLunar 正反换算闭环：农历(闰4,14) → 公历 → 农历 应还原。
  const back = deriveFromLunar(2020, 4, 14, true);
  assert.equal(back.birthday, '2020-06-05');
  assert.equal(back.birthdayLunar, derived.birthdayLunar);
  assert.equal(back.zodiac, derived.zodiac);
  assert.equal(back.constellation, derived.constellation);
});

test('年越界（1899 / 2101）返回 null', () => {
  assert.equal(deriveFromLunar(1899, 1, 1), null);
  assert.equal(deriveFromLunar(2101, 1, 1), null);
});

test('非法月/日与不存在的闰月返回 null', () => {
  assert.equal(deriveFromLunar(1990, 13, 1), null);   // 月越界
  assert.equal(deriveFromLunar(1990, 4, 31), null);   // 日越界
  assert.equal(deriveFromLunar(2021, 4, 1, true), null); // 2021 无闰月
  assert.equal(leapMonthOf(2021), 0, '2021 年无闰月');
  assert.equal(leapMonthOf(1899), 0, '年份越界时 leapMonthOf 返回 0');
});
