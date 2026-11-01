/**
 * Modul: 家庭库存（Home Inventory）— Kategorien & Einheiten
 * Zweck: Isomorphe Taxonomie für das eigenständige 家庭库存-Modul
 * Abhängigkeiten: keine (auch server/routes/home-inventory.js importiert diese
 * Datei — deshalb nur reine Konstanten/Funktionen, kein DOM, kein i18n)
 *
 * Zwei Ebenen:
 *   1. FESTE Basisliste (unten) — deckt den Haushalt ab: Putzmittel, Papier,
 *      Pflege, Küchenverbrauch, Textil, Snacks, Vorrat, Aufbewahrung, Medizin,
 *      Baby, Haustier, Büro, Garten, Auto, Festtage. Die Labels kommen via i18n
 *      (homeInventory.cat.<key> / unit.<key>), damit alle Sprachen sie tragen.
 *   2. BENUTZERDEFINIERTE Ergänzungen — seit v172 in der Tabelle
 *      home_inventory_options (kind = 'category' | 'unit'). Deren `name` IST
 *      zugleich der Speicherwert in home_inventory_items.category/unit, denn ein
 *      eigener Name hat keinen i18n-Key. Deshalb gilt: custom.key === name.
 *
 * Die festen Keys sind damit gleichzeitig geschützte Namen — ein Benutzer kann
 * keine Kategorie "cleaning" anlegen (das wäre ein zweiter Name für dieselbe
 * Sache). Der Server prüft das beim Anlegen.
 *
 * Sortierung: feste Liste zuerst (Reihenfolge = Anzeige), eigene Einträge
 * danach in ihrer Anlagereihenfolge. `homeCategoryOrder()` kennt nur die feste
 * Liste; der Server baut die vollständige Ordnung aus DB + dieser Liste.
 */

export const HOME_INVENTORY_CATEGORIES = Object.freeze([
  { key: 'cleaning',      icon: 'spray-can' },   // 清洁洗护：洗衣液、洗洁精、消毒液
  { key: 'paper',         icon: 'scroll' },      // 纸品：抽纸、卷纸、湿巾
  { key: 'personal-care', icon: 'droplets' },    // 个护美妆：沐浴露、洗发水、护肤品、备用牙刷
  { key: 'kitchen-supplies', icon: 'utensils' }, // 厨房耗材：保鲜膜、铝箔、一次性手套
  { key: 'textiles',      icon: 'shirt' },       // 家纺织物：洗毛巾、毛巾、床品
  { key: 'snacks',        icon: 'cookie' },      // 零食饮品：零食、咖啡豆、茶叶
  { key: 'household',     icon: 'lamp' },        // 家居日用：电池、灯泡、垃圾袋
  { key: 'storage',       icon: 'archive' },     // 收纳整理：收纳盒、衣架、挂钩
  { key: 'firstaid',      icon: 'cross' },       // 医药应急：创可贴、常备药、应急用品
  { key: 'baby',          icon: 'baby' },        // 母婴用品：纸尿裤、湿巾、奶粉
  { key: 'pet',           icon: 'paw-print' },   // 宠物用品：猫砂、粮、拾便袋
  { key: 'stationery',    icon: 'pencil' },      // 文具办公：笔、便签、胶带
  { key: 'garden',        icon: 'sprout' },      // 园艺绿植：花肥、花盆、种子
  { key: 'car',           icon: 'car' },         // 车用：玻璃水、香薰、清洁湿巾
  { key: 'festival',      icon: 'gift' },        // 节庆用品：装饰、礼盒、包装
  { key: 'other',         icon: 'package' },     // 其他
]);

export const DEFAULT_HOME_CATEGORY = 'household';

export const HOME_INVENTORY_UNITS = Object.freeze([
  'pcs',     // 个
  'bottle',  // 瓶
  'box',     // 盒
  'pack',    // 包
  'bag',     // 袋
  'roll',    // 卷
  'tube',    // 支
  'can',     // 罐
  'pair',    // 双
  'sheet',   // 片
  'set',     // 套
  'kg',      // 千克（咖啡豆、洗衣粉）
  'g',       // 克
  'l',       // 升（大桶洗衣液、柔顺剂）
  'ml',      // 毫升
  'meter',   // 米（保鲜膜、铝箔）
  'bar',     // 块（肥皂、香皂）
  'capsule', // 粒（洗衣凝珠、药片）
  'stick',   // 根（牙膏、香）
  'case',    // 箱
]);

export const DEFAULT_HOME_UNIT = 'pcs';

/**
 * Feste Lagerorte im Haushalt — dieselbe Bauart wie Kategorien/Einheiten:
 * gespeichert wird der Schlüssel, angezeigt der übersetzte Text. Eigene Orte
 * stehen in home_inventory_options (kind = 'location') und tragen ihren Namen
 * als Wert. Ein leerer Wert heißt „kein Ort angegeben" und ist erlaubt.
 */
export const HOME_INVENTORY_LOCATIONS = Object.freeze([
  'bathroom',  // 卫生间
  'kitchen',   // 厨房
  'balcony',   // 阳台
  'storage',   // 储物间
  'laundry',   // 洗衣区
  'bedroom',   // 卧室
  'living',    // 客厅
  'entryway',  // 玄关
  'fridge',    // 冰箱
  'garage',    // 车库
]);

/** Icon für benutzerdefinierte Kategorien (lucide-Name). */
export const HOME_CUSTOM_CATEGORY_ICON = 'tag';

/** Höchstlängen für eigene Namen — im Formular und im Server identisch. */
export const HOME_OPTION_MAX = Object.freeze({ category: 20, unit: 8, location: 20 });

const CATEGORY_KEYS = new Set(HOME_INVENTORY_CATEGORIES.map((c) => c.key));
const UNIT_KEYS = new Set(HOME_INVENTORY_UNITS);
const LOCATION_KEYS = new Set(HOME_INVENTORY_LOCATIONS);

/** Kategorie-Key der festen Liste? (Eigene Kategorien stehen in der DB.) */
export function isValidHomeCategory(key) {
  return CATEGORY_KEYS.has(String(key));
}

/** Einheiten-Key der festen Liste? (Eigene Einheiten stehen in der DB.) */
export function isValidHomeUnit(key) {
  return UNIT_KEYS.has(String(key));
}

/** Lagerort-Key der festen Liste? (Eigene Orte stehen in der DB.) */
export function isValidHomeLocation(key) {
  return LOCATION_KEYS.has(String(key));
}

/**
 * Name eines eigenen Kategorie-/Einheiten-Eintrags normalisieren:
 * Rand- und Mehrfach-Leerzeichen zusammenziehen, Steuerzeichen entfernen.
 * Der Name ist der Speicherwert — zwei Schreibweisen mit doppeltem Leerzeichen
 * wären sonst zwei verschiedene Kategorien.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeHomeOptionName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Prüft einen eigenen Namen gegen Länge und Kollision mit der festen Liste.
 * Die Prüfung gegen bereits vorhandene eigene Einträge macht der Server (DB).
 * @param {string} name normalisierter Name
 * @param {'category'|'unit'|'location'} kind
 * @returns {'ok'|'required'|'too-long'|'reserved'}
 */
export function checkHomeOptionName(name, kind) {
  const max = HOME_OPTION_MAX[kind] ?? HOME_OPTION_MAX.category;
  if (!name) return 'required';
  if (name.length > max) return 'too-long';
  const reserved = kind === 'unit'
    ? isValidHomeUnit(name)
    : kind === 'location'
      ? isValidHomeLocation(name)
      : isValidHomeCategory(name);
  if (reserved) return 'reserved';
  return 'ok';
}

/**
 * Anzahl möglicher Zeichen für ein Eingabefeld (maxlength).
 * @param {'category'|'unit'|'location'} kind
 * @returns {number}
 */
export function homeOptionMaxLength(kind) {
  return HOME_OPTION_MAX[kind] ?? HOME_OPTION_MAX.category;
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
 * Position einer festen Kategorie in der Anzeigereihenfolge („其他" zuletzt).
 * Unbekannte Keys (= eigene Kategorien) liefern die Länge der festen Liste und
 * landen damit hinter allen festen Kategorien; für die vollständige Ordnung
 * inklusive eigener Einträge baut der Server eine Map (siehe Router).
 * @param {string} key
 * @returns {number}
 */
export function homeCategoryOrder(key) {
  const i = HOME_INVENTORY_CATEGORIES.findIndex((c) => c.key === key);
  return i === -1 ? HOME_INVENTORY_CATEGORIES.length : i;
}

/** Icon zu einem festen Kategorie-Key (Fallback: Paket). */
export function homeCategoryIcon(key) {
  return HOME_INVENTORY_CATEGORIES.find((c) => c.key === key)?.icon ?? 'package';
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

// --------------------------------------------------------
// 常用物品模板 / 条码（v173）
// --------------------------------------------------------

/**
 * 常用日用品模板：名字走 i18n（homeInventory.tpl.<key>），类别/单位/位置用
 * 上面固定的键。点一下即可填好一个常见商品的骨架，剩下的只是数量和效期。
 *
 * 为什么放在代码里而不是数据库：这是一份"大多数家庭都有的东西"的清单，
 * 不是用户数据 —— 它不该被误删，也不该为每个家庭复制一份。用户自己的常用
 * 商品会随着录入自然出现在历史里（见 page 的 homeItemSuggestions）。
 */
export const HOME_ITEM_TEMPLATES = Object.freeze([
  { key: 'laundry',      category: 'cleaning',      unit: 'bottle', location: 'laundry',  min_quantity: 1 },
  { key: 'dishSoap',     category: 'cleaning',      unit: 'bottle', location: 'kitchen',  min_quantity: 1 },
  { key: 'handSoap',     category: 'cleaning',      unit: 'bottle', location: 'bathroom', min_quantity: 1 },
  { key: 'toiletPaper',  category: 'paper',         unit: 'roll',   location: 'bathroom', min_quantity: 4 },
  { key: 'facialTissue', category: 'paper',         unit: 'pack',   location: 'living',   min_quantity: 2 },
  { key: 'wetWipes',     category: 'paper',         unit: 'pack',   location: 'living',   min_quantity: 1 },
  { key: 'shampoo',      category: 'personal-care', unit: 'bottle', location: 'bathroom', min_quantity: 1 },
  { key: 'bodyWash',     category: 'personal-care', unit: 'bottle', location: 'bathroom', min_quantity: 1 },
  { key: 'toothpaste',   category: 'personal-care', unit: 'tube',   location: 'bathroom', min_quantity: 1 },
  { key: 'toothbrush',   category: 'personal-care', unit: 'pcs',    location: 'bathroom', min_quantity: 2 },
  { key: 'trashBag',     category: 'household',     unit: 'pack',   location: 'kitchen',  min_quantity: 1 },
  { key: 'battery',      category: 'household',     unit: 'pack',   location: 'storage',  min_quantity: 1 },
  { key: 'coffee',       category: 'snacks',        unit: 'bag',    location: 'kitchen',  min_quantity: 1 },
  { key: 'snack',        category: 'snacks',        unit: 'pack',   location: 'living',   min_quantity: 1 },
  { key: 'towel',        category: 'textiles',      unit: 'pcs',    location: 'bathroom', min_quantity: 2 },
  { key: 'catLitter',    category: 'pet',           unit: 'bag',    location: 'balcony',  min_quantity: 1 },
]);

/**
 * 条码/二维码的合法形状：4–64 位字母、数字、连字符。EAN-13/UPC-A 是纯数字，
 * 二维码可能带字母 —— 都收，但拒绝空白与任意符号（它们只可能是误扫）。
 */
const BARCODE_RE = /^[A-Za-z0-9-]{4,64}$/;

/** Rohwert eines Scans auf die gespeicherte Form bringen ('' = kein Code). */
export function normalizeHomeBarcode(value) {
  const raw = String(value ?? '').trim();
  return BARCODE_RE.test(raw) ? raw : '';
}

/** Ist der Wert ein speicherbarer Code? Nur für die Formularprüfung. */
export function isValidHomeBarcode(value) {
  return BARCODE_RE.test(String(value ?? '').trim());
}

/**
 * 消耗速度 → 预计还能用几天。
 *
 * `perDay` kommt aus dem Verbrauch der letzten Tage (Server rechnet ihn aus den
 * Logs). Ohne Verbrauch gibt es keine Prognose — dann null, nicht "unendlich".
 * @param {number} quantity
 * @param {number|null} perDay
 * @returns {number|null} ganze Tage, oder null wenn keine Rate vorliegt
 */
export function homeDaysLeft(quantity, perDay) {
  const q = Number(quantity);
  const rate = Number(perDay);
  if (!Number.isFinite(q) || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.max(0, Math.floor(q / rate));
}
