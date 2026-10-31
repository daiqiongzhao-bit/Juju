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
