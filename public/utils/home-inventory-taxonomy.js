/**
 * Modul: 家庭库存（Home Inventory）— 分类与单位固定清单
 * Zweck: Isomorphe Taxonomie für das eigenständige 家庭库存-Modul
 * Abhängigkeiten: keine (auch server/routes/home-inventory.js importiert diese
 * Datei — deshalb nur reine Konstanten/Funktionen, kein DOM, kein i18n)
 *
 * Bewusst FIX statt benutzerverwaltet (anders als pantry_locations/
 * pantry_units): 家庭库存管理的是日用品，类别和单位是稳定的小集合（十几个），
 * 先用固定清单把模块立起来；将来要用户自定义时，可以照 v157 的
 * pantry_units 模式迁移，服务端校验只换数据源、路由结构不变。
 *
 * 类别 key 是存储值（DB category 列），标签走 i18n:
 *   homeInventory.cat.<key>（zh/en 已录入，其余语言回退 zh）
 * 单位同理: homeInventory.unit.<key>
 */

export const HOME_INVENTORY_CATEGORIES = Object.freeze([
  { key: 'cleaning',      icon: 'spray-can' },   // 清洁洗护：洗衣液、清洁剂、消毒液
  { key: 'paper',         icon: 'scroll' },      // 纸品：抽纸、卷纸、湿巾
  { key: 'personal-care', icon: 'droplets' },    // 个护美妆：沐浴露、洗发水、护肤品、备用牙刷
  { key: 'textiles',      icon: 'shirt' },       // 家纺织物：洗毛巾、毛巾、床品
  { key: 'snacks',        icon: 'cookie' },      // 零食饮品：零食、咖啡豆、茶叶
  { key: 'household',     icon: 'lamp' },        // 家居日用：电池、灯泡、垃圾袋
  { key: 'firstaid',      icon: 'cross' },       // 医药应急：创可贴、常备药、应急用品
  { key: 'other',         icon: 'package' },     // 其他
]);

export const DEFAULT_HOME_CATEGORY = 'household';

export const HOME_INVENTORY_UNITS = Object.freeze([
  'pcs',    // 个
  'bottle', // 瓶
  'box',    // 盒
  'pack',   // 包
  'bag',    // 袋
  'roll',   // 卷
  'tube',   // 支
  'can',    // 罐
  'pair',   // 双
  'sheet',  // 片
  'set',    // 套
]);

export const DEFAULT_HOME_UNIT = 'pcs';

const CATEGORY_KEYS = new Set(HOME_INVENTORY_CATEGORIES.map((c) => c.key));
const UNIT_KEYS = new Set(HOME_INVENTORY_UNITS);

/** 类别 key 是否合法（服务端 oneOf 校验 + 客户端防御）。 */
export function isValidHomeCategory(key) {
  return CATEGORY_KEYS.has(String(key));
}

/** 单位 key 是否合法。 */
export function isValidHomeUnit(key) {
  return UNIT_KEYS.has(String(key));
}

/**
 * 数量归一化：非有限数 → fallback；负数 → 0；最多两位小数。
 * 与 pantry 的 normalizePantryQuantity 同语义：REAL 存储只有一个目的 ——
 * 能做加减、能和 min_quantity 比较。
 * @param {unknown} value
 * @param {{ fallback?: number }} [opts]
 * @returns {number}
 */
export function normalizeHomeQuantity(value, { fallback = 1 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.round(n * 100) / 100);
}

/**
 * 类别在列表中的排序序号（服务端 ORDER BY 和客户端分组共用同一份顺序，
 * 保证"其他"永远垫底）。
 * @param {string} key
 * @returns {number}
 */
export function homeCategoryOrder(key) {
  const i = HOME_INVENTORY_CATEGORIES.findIndex((c) => c.key === key);
  return i === -1 ? HOME_INVENTORY_CATEGORIES.length : i;
}

// --------------------------------------------------------
// 有效期 / 库存状态
// --------------------------------------------------------

/**
 * 提前多少天算"临期"。
 *
 * 和厨房（EXPIRY_SOON_DAYS = 7，pantry-status.js）故意不同：食材是"这周要吃掉"，
 * 日用品是"下次补货时顺手带一瓶"。30 天是补货节奏的长度，7 天对洗衣液没有
 * 任何可操作的含义。
 */
export const HOME_INVENTORY_SOON_DAYS = 30;

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 校验 YYYY-MM-DD 且必须是真实存在的日历日（拒绝 2026-02-30）。
 *
 * 服务端 middleware/validate.js 的 date() 只查格式，不查日历；"2 月 30 日"
 * 会原样进库，然后在界面上显示成一个不存在的日子。这里补上后半步。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidHomeDateKey(value) {
  if (typeof value !== 'string') return false;
  const m = DATE_KEY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** 本地日历日的 YYYY-MM-DD（不用 toISOString：它会滑到前一天/后一天）。 */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** todayKey + n 天（本地日历，跨月/跨年/夏令时都按日历算）。 */
export function addHomeDays(todayKey, n) {
  const [y, m, d] = todayKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return localDateKey(dt);
}

/**
 * 一个批次（= 一行）的库存/效期状态。
 *
 * out   数量为 0（全部领用完）—— 列表上显示"已用完，需要补货"
 * low   数量 > 0 但已到/低于低量阈值
 * expiry 'expired' | 'soon' | null
 * @param {object} item
 * @param {string} [todayKey]
 * @returns {{ out: boolean, low: boolean, expiry: 'expired'|'soon'|null, days: number|null }}
 */
export function homeItemStatus(item, todayKey = localDateKey()) {
  const quantity = Number(item?.quantity ?? 0);
  const min = item?.min_quantity == null ? null : Number(item.min_quantity);

  const out = !Number.isFinite(quantity) || quantity <= 0;
  // "快用完"排除"已用完"：后者有更明确的徽章，不该同时挂两个。
  const low = !out && min !== null && Number.isFinite(min) && quantity <= min;

  let expiry = null;
  let days = null;
  const expiresOn = item?.expires_on || null;
  if (expiresOn && DATE_KEY_RE.test(String(expiresOn))) {
    days = Math.round(
      (Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86_400_000,
    );
    if (days < 0) expiry = 'expired';
    else if (expiresOn <= addHomeDays(todayKey, HOME_INVENTORY_SOON_DAYS)) expiry = 'soon';
  }

  return { out, low, expiry, days };
}

/**
 * 同名批次的归组键（名称 + 单位，大小写不敏感）。
 * 单位不同的同名商品不是同一批"库存"，不该被算作一个商品的多个批次。
 */
export function homeBatchKey(item) {
  return `${String(item?.name ?? '').trim().toLowerCase()}|${String(item?.unit ?? '')}`;
}

/**
 * 批次排序：先按名称，再按有效期升序（无有效期的排最后），最后按 id。
 * 服务端 loadItems() 用它，客户端也用它把同名列排在一起 —— 一份规则，两处
 * 一致，免得"先过期"和"后过期"在某处被排反。
 */
export function compareHomeBatches(a, b) {
  const na = String(a?.name ?? '').toLowerCase();
  const nb = String(b?.name ?? '').toLowerCase();
  if (na !== nb) return na < nb ? -1 : 1;
  const ea = a?.expires_on || '9999-12-31';
  const eb = b?.expires_on || '9999-12-31';
  if (ea !== eb) return ea < eb ? -1 : 1;
  return Number(a?.id ?? 0) - Number(b?.id ?? 0);
}
