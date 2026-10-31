/**
 * Modul: Lunar Fields (R1 - rnw 设计补差)
 * Zweck: 公历生日 → 农历生日/生肖/星座的自动换算与请求字段裁决。
 *
 * 数据模型（用户已确认决策②）：公历 `birthday` 是主数据，
 * `birthday_lunar`/`zodiac`/`constellation` 为服务端派生字段，
 * 请求可显式提供以手动修正；生日清空时派生字段一并置 NULL。
 *
 * 枚举单一数据源（约定 C12）：ZODIACS/CONSTELLATIONS 定义于此，
 * 经 `GET /relationships/meta/options` 下发前端，路由层 oneOf 校验同源。
 *
 * Abhängigkeiten: lunar-javascript（纯 JS，前后端可复用）
 */

import { Lunar, Solar, LunarYear } from 'lunar-javascript';
import { createLogger } from '../logger.js';

const log = createLogger('LunarFields');

/** 生肖枚举（12 值，按鼠→猪顺序）。 */
export const ZODIACS = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

/** 星座枚举（12 值，按白羊→双鱼顺序）。 */
export const CONSTELLATIONS = [
  '白羊座', '金牛座', '双子座', '巨蟹座', '狮子座', '处女座',
  '天秤座', '天蝎座', '射手座', '摩羯座', '水瓶座', '双鱼座',
];

/** 派生字段三件套的空值（生日缺失/非法/换算失败时返回）。 */
const NULL_FIELDS = { birthdayLunar: null, zodiac: null, constellation: null };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// lunar-javascript 的农历数据覆盖范围（1900-2100）。范围外不猜、不换算。
const LUNAR_MIN_YEAR = 1900;
const LUNAR_MAX_YEAR = 2100;

/**
 * Prüft, ob ein YYYY-MM-DD-String ein real existierendes Datum ist.
 * `Solar.fromYmd` wirft zwar bei Monat 0/13, rollt aber ungültige Tage
 * (z. B. 1990-02-30) stillschweigend über — daher die UTC-Roundtrip-Prüfung.
 * @param {string} value
 * @returns {boolean}
 */
function isRealDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 公历生日 → 农历生日/生肖/星座。
 *
 * 农历生日格式 `YYYY-MM-DD`（零填充）；闰月记 `YYYY-LMM-DD`（如 2020-L04-15）。
 * 生肖取农历年（`getYearShengXiao`），星座由公历月日决定（`getXingzuo`，
 * 库返回「金牛」等形式，按 PRD 枚举补「座」后缀）。
 *
 * 生日为空/非 YYYY-MM-DD → 三字段全 NULL（不抛错、不记日志）；
 * 真实日期校验失败或换算异常 → 记 warn 并返回三 NULL（不阻塞保存）。
 *
 * @param {string|null|undefined} birthday 公历生日，YYYY-MM-DD
 * @returns {{ birthdayLunar: string|null, zodiac: string|null, constellation: string|null }}
 */
export function deriveLunarFields(birthday) {
  if (!birthday || typeof birthday !== 'string') return { ...NULL_FIELDS };

  const value = birthday.trim();
  if (!DATE_RE.test(value)) return { ...NULL_FIELDS };

  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);

  if (!isRealDate(value)) {
    log.warn(`deriveLunarFields: "${value}" is not a real calendar date — derived fields set to NULL.`);
    return { ...NULL_FIELDS };
  }
  if (year < LUNAR_MIN_YEAR || year > LUNAR_MAX_YEAR) {
    log.warn(`deriveLunarFields: year ${year} outside supported range ${LUNAR_MIN_YEAR}-${LUNAR_MAX_YEAR} — derived fields set to NULL.`);
    return { ...NULL_FIELDS };
  }

  try {
    const solar = Solar.fromYmd(year, Number(monthStr), Number(dayStr));
    const lunar = solar.getLunar();

    // 闰月：getMonth() < 0（如 -4 = 闰四月），记 L 前缀。
    const lunarMonth = lunar.getMonth();
    const monthPart = String(Math.abs(lunarMonth)).padStart(2, '0');
    const dayPart = String(lunar.getDay()).padStart(2, '0');
    const birthdayLunar = lunarMonth < 0
      ? `${lunar.getYear()}-L${monthPart}-${dayPart}`
      : `${lunar.getYear()}-${monthPart}-${dayPart}`;

    // getXingzuo() liefert z. B. 「金牛」 — PRD-Enum verlangt 「金牛座」.
    const constellation = `${solar.getXingzuo()}座`;

    return { birthdayLunar, zodiac: lunar.getYearShengXiao(), constellation };
  } catch (err) {
    log.warn(`deriveLunarFields: conversion failed for "${value}" — derived fields set to NULL.`, err);
    return { ...NULL_FIELDS };
  }
}

/**
 * 农历生日 → 公历生日 + 派生三字段（deriveLunarFields 的逆换算）。
 *
 * 农历闰月格式与 deriveLunarFields 一致：`YYYY-LMM-DD`（如 2020-L04-15）。
 * 生肖取农历年（`getYearShengXiao`），星座由换算出的公历月日决定
 * （`getXingzuo` 返回「金牛」等形式，按 PRD 枚举补「座」后缀）。
 *
 * 非法入参（年越界 1900-2100、月/日越界、不存在的农历日期——如该年无此闰月、
 * 该月无 30 日）→ 返回 null，不抛错、不记日志（调用方据此转 400 或置 NULL）。
 *
 * @param {number} year   农历年（1900-2100）
 * @param {number} month  农历月（1-12）
 * @param {number} day    农历日（1-30）
 * @param {boolean} [isLeap=false] 是否闰月（该年该月必须实际有闰月）
 * @returns {{ birthday: string, birthdayLunar: string, zodiac: string, constellation: string }|null}
 *          换算成功返回四字段，失败返回 null
 */
export function deriveFromLunar(year, month, day, isLeap = false) {
  if (!Number.isInteger(year) || year < LUNAR_MIN_YEAR || year > LUNAR_MAX_YEAR) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 30) return null;

  try {
    // lunar-javascript 约定：闰月用负数月（-4 = 闰四月）；不存在的农历日期
    // （无此闰月、日超出该月天数）会抛错，收敛为 null。
    const lunar = Lunar.fromYmd(year, isLeap ? -month : month, day);
    const solar = lunar.getSolar();

    const monthPart = String(month).padStart(2, '0');
    const dayPart = String(day).padStart(2, '0');
    const birthdayLunar = isLeap
      ? `${year}-L${monthPart}-${dayPart}`
      : `${year}-${monthPart}-${dayPart}`;

    // getXingzuo() liefert z. B. 「金牛」 — PRD-Enum verlangt 「金牛座」.
    const constellation = `${solar.getXingzuo()}座`;

    return {
      birthday: solar.toYmd(),
      birthdayLunar,
      zodiac: lunar.getYearShengXiao(),
      constellation,
    };
  } catch {
    return null;
  }
}

/**
 * 查询某个农历年的闰月序号（0 = 该年无闰月）。前端据此决定「闰月」选项是否可选。
 * @param {number} year 农历年
 * @returns {number} 闰月序号（1-12），无闰月返回 0；入参非法返回 0
 */
export function leapMonthOf(year) {
  if (!Number.isInteger(year) || year < LUNAR_MIN_YEAR || year > LUNAR_MAX_YEAR) return 0;
  try {
    return LunarYear.fromYear(year).getLeapMonth() || 0;
  } catch {
    return 0;
  }
}

/**
 * 请求字段裁决：按 TASKS.md 四种情形产出待写派生字段 patch。
 *
 * - `body.birthday === undefined`（本次未动生日）→ 不产生派生字段 patch；
 * - 请求显式提供 `birthdayLunar`/`zodiac`/`constellation`（含显式 null 清除）
 *   → 以请求值为准（允许手动修正）；
 * - 未显式提供且 `body.birthday` 非空 → deriveLunarFields 自动填充；
 * - 未显式提供且 `body.birthday` 为空 → 三个派生字段置 NULL。
 *
 * @param {object} body    请求体（已过路由校验的原始字段）
 * @param {object|null} [current] 库中现行行（契约预留参数；当前裁决规则不依赖它）
 * @returns {object} 仅含需写入的派生字段（可能为空对象）
 */
export function applyLunarFields(body, current = null) {
  if (body.birthday === undefined) return {};

  const patch = {};
  const derivedKeys = ['birthdayLunar', 'zodiac', 'constellation'];
  const explicitKeys = derivedKeys.filter((key) => body[key] !== undefined);

  if (explicitKeys.length > 0) {
    // 手动修正优先：显式提供的字段（含 null）以请求值为准。
    for (const key of explicitKeys) patch[key] = body[key];
    // 未显式提供的派生字段跟随生日状态，与自动换算规则一致。
    for (const key of derivedKeys) {
      if (key in patch) continue;
      patch[key] = body.birthday ? deriveLunarFields(body.birthday)[key] : null;
    }
    return patch;
  }

  if (body.birthday) return { ...deriveLunarFields(body.birthday) };
  return { ...NULL_FIELDS };
}
