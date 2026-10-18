/**
 * Modul: 导入列映射（Import Mapping）
 * Zweck: 描述「哪些模块可以导入、每个模块有哪些目标字段、源表头如何自动对齐」。
 *
 * 设计约定：
 *   - 这里只有数据描述与纯函数：**不读数据库、不做写入**，因此可以被
 *     单元测试直接 import（无需 better-sqlite3 / Node 22）。
 *   - 新增模块只需往 IMPORT_MODULES 里追加一项，并在
 *     server/services/import-runner.js 里加一个 writer —— 路由、预览、
 *     幂等登记全部自动生效（预算/影音的扩展位就在这里）。
 *   - 别名表覆盖中英德常见表头：Notion(英文)、飞书(中英混排)、
 *     Google Calendar(英文)、手机备忘录(多为中文)。
 */

import { MAX_TITLE, MAX_TEXT, MAX_SHORT } from '../middleware/validate.js';

/** 源表头归一化：小写、去掉所有非字母数字的字符（空格/下划线/连字符统一消失）。 */
function normalizeHeader(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9一-龥]+/g, '');
}

/**
 * 目标字段定义。
 * @typedef {Object} ImportField
 * @property {string} key            目标字段名
 * @property {string} label          界面展示名（英文兜底，前端再用 i18n 覆盖）
 * @property {'text'|'date'|'time'|'number'|'enum'|'list'} type
 * @property {boolean} [required]    是否必填（缺失则该行记为失败）
 * @property {number} [max]          文本最大长度
 * @property {string[]} aliases      自动匹配的别名（已归一化比较）
 * @property {Record<string, string>} [enumMap] 枚举取值的归一化表
 * @property {string[]} [enumValues] 允许的最终取值
 */

/** 任务本体字段。 */
const TASK_FIELDS = [
  {
    key: 'title', label: 'Title', type: 'text', required: true, max: MAX_TITLE,
    aliases: ['title', 'name', 'task', 'todo', 'subject', 'summary', 'aufgabe', 'titel',
      '标题', '任务', '名称', '事项', '主题'],
  },
  {
    key: 'description', label: 'Description', type: 'text', max: MAX_TEXT,
    aliases: ['description', 'notes', 'note', 'body', 'content', 'details', 'beschreibung', 'notizen',
      '描述', '备注', '说明', '详情', '內容'],
  },
  {
    key: 'category', label: 'Category', type: 'text', max: MAX_SHORT,
    aliases: ['category', 'list', 'group', 'tag', 'tags', 'project', 'kategorie',
      '分类', '类别', '分组', '清单', '标签'],
  },
  {
    key: 'priority', label: 'Priority', type: 'enum',
    enumValues: ['none', 'low', 'medium', 'high', 'urgent'],
    enumMap: {
      none: 'none', low: 'low', normal: 'medium', medium: 'medium', mid: 'medium', med: 'medium',
      high: 'high', urgent: 'urgent', critical: 'urgent',
      niedrig: 'low', mittel: 'medium', hoch: 'high', dringend: 'urgent',
      低: 'low', 中: 'medium', 高: 'high', 紧急: 'urgent', 无: 'none',
    },
    aliases: ['priority', 'prio', 'importance', 'urgency', 'prioritat', 'priorität',
      '优先级', '優先級', '重要程度'],
  },
  {
    key: 'status', label: 'Status', type: 'enum',
    enumValues: ['open', 'in_progress', 'done'],
    enumMap: {
      open: 'open', todo: 'open', pending: 'open', neue: 'open', open_: 'open',
      'inprogress': 'in_progress', 'in progress': 'in_progress', doing: 'in_progress', active: 'in_progress',
      done: 'done', completed: 'done', complete: 'done', finished: 'done', erledigt: 'done',
      待办: 'open', 未完成: 'open', 进行中: 'in_progress', 已完成: 'done', 完成: 'done',
    },
    aliases: ['status', 'state', 'stage', 'done', 'completed', 'status2',
      '状态', '狀態', '进度'],
  },
  {
    key: 'due_date', label: 'Due date', type: 'date',
    aliases: ['duedate', 'due', 'date', 'deadline', 'duedate2', 'faelligkeitsdatum', 'fälligkeitsdatum', 'datum',
      '截止日期', '到期日', '日期', '結束日期', '结束日期'],
  },
  {
    key: 'due_time', label: 'Due time', type: 'time',
    aliases: ['duetime', 'time', 'hour', 'uhrzeit', 'zeit',
      '时间', '時間', '截止時間'],
  },
];

/** 联系人本体字段（phone/address 最终走 SM4 加密，见 import-runner）。 */
const CONTACT_FIELDS = [
  {
    key: 'name', label: 'Name', type: 'text', required: true, max: MAX_TITLE,
    aliases: ['name', 'fullname', 'displayname', 'contact', 'givenname', 'firstname', 'nachname', 'vollstandigername',
      '姓名', '名字', '名称', '聯絡人', '联系人'],
  },
  {
    key: 'category', label: 'Category', type: 'text', max: MAX_SHORT,
    aliases: ['category', 'group', 'tag', 'tags', 'type', 'kategorie', 'gruppe',
      '分组', '分类', '類別', '關係'],
  },
  {
    key: 'phone', label: 'Phone', type: 'text', max: MAX_SHORT,
    aliases: ['phone', 'tel', 'telephone', 'mobile', 'cell', 'phonenumber', 'telefon', 'handy',
      '手机', '電話', '电话', '手機', '联系电话'],
  },
  {
    key: 'email', label: 'Email', type: 'text', max: MAX_SHORT,
    aliases: ['email', 'mail', 'emailaddress', 'e-mail', 'e_mail', 'emailadresse',
      '邮箱', '電子郵件', '电子邮件', '邮箱地址'],
  },
  {
    key: 'address', label: 'Address', type: 'text', max: MAX_TEXT,
    aliases: ['address', 'addr', 'street', 'location', 'home', 'adresse', 'strasse', 'straße',
      '地址', '住址', '街道'],
  },
  {
    key: 'notes', label: 'Notes', type: 'text', max: MAX_TEXT,
    aliases: ['notes', 'note', 'remark', 'comment', 'comments', 'notizen', 'anmerkung',
      '备注', '註記', '评论'],
  },
  {
    key: 'birthday', label: 'Birthday', type: 'date',
    aliases: ['birthday', 'birthdate', 'dob', 'dateofbirth', 'geburtstag', 'geburtsdatum',
      '生日', '出生日期'],
  },
  {
    key: 'organization', label: 'Organization', type: 'text', max: MAX_SHORT,
    aliases: ['organization', 'company', 'org', 'employer', 'firma', 'organisation',
      '公司', '组织', '單位', '单位'],
  },
  {
    key: 'job_title', label: 'Job title', type: 'text', max: MAX_SHORT,
    aliases: ['jobtitle', 'title', 'role', 'position', 'job', 'beruf', 'position2',
      '职位', '職稱', '职务'],
  },
  {
    key: 'nickname', label: 'Nickname', type: 'text', max: MAX_SHORT,
    aliases: ['nickname', 'alias', 'nick', 'spitzname',
      '昵称', '暱稱', '别名'],
  },
];

/** 购物清单：一行 = 一件商品，list 列决定落在哪张清单（不存在则新建）。 */
const SHOPPING_FIELDS = [
  {
    key: 'list', label: 'List', type: 'text', max: MAX_TITLE,
    aliases: ['list', 'listname', 'shoppinglist', 'group', 'board', 'liste', 'einkaufsliste',
      '清单', '列表', '購物清單', '购物清单'],
  },
  {
    key: 'name', label: 'Item', type: 'text', required: true, max: MAX_TITLE,
    aliases: ['item', 'name', 'product', 'article', 'title', 'produkt', 'artikel',
      '商品', '物品', '名称', '項目'],
  },
  {
    key: 'quantity', label: 'Quantity', type: 'text', max: MAX_SHORT,
    aliases: ['quantity', 'qty', 'amount', 'count', 'menge', 'anzahl',
      '数量', '數量', '份量'],
  },
  {
    key: 'category', label: 'Category', type: 'text', max: MAX_SHORT,
    aliases: ['category', 'aisle', 'section', 'department', 'kategorie', 'abteilung',
      '分类', '類別', '区域'],
  },
  {
    key: 'notes', label: 'Notes', type: 'text', max: MAX_TEXT,
    aliases: ['notes', 'note', 'comment', 'notizen',
      '备注', '備註'],
  },
];

/** 菜谱：ingredients 支持「鸡蛋|2个|蛋类」或「2个 鸡蛋」两种写法。 */
const RECIPE_FIELDS = [
  {
    key: 'title', label: 'Title', type: 'text', required: true, max: MAX_TITLE,
    aliases: ['title', 'name', 'recipe', 'recipename', 'rezept', 'titel', 'gericht',
      '标题', '菜名', '食谱', '食譜', '菜品'],
  },
  {
    key: 'notes', label: 'Instructions', type: 'text', max: MAX_TEXT,
    aliases: ['notes', 'instructions', 'steps', 'method', 'directions', 'preparation', 'anleitung', 'zubereitung',
      '步骤', '做法', '步驟', '做法說明', '说明'],
  },
  {
    key: 'recipe_url', label: 'Source URL', type: 'text', max: MAX_TEXT,
    aliases: ['url', 'link', 'source', 'sourceurl', 'website', 'originallink', 'originalurl', 'quelle',
      '链接', '網址', '网址', '来源'],
  },
  {
    key: 'meal_types', label: 'Meal types', type: 'text', max: MAX_SHORT,
    aliases: ['mealtypes', 'mealtype', 'meal', 'course', 'mahlzeit',
      '餐次', '餐別', '用餐时段'],
  },
  {
    key: 'servings', label: 'Servings', type: 'number',
    aliases: ['servings', 'portions', 'yield', 'people', 'persons', 'portionen', 'personen',
      '份量', '人数', '份数', '幾人份'],
  },
  {
    key: 'duration_minutes', label: 'Minutes', type: 'number',
    aliases: ['duration', 'durationminutes', 'minutes', 'totaltime', 'time', 'cooktime', 'dauer', 'zeit', 'minuten',
      '时长', '時間', '耗时', '分钟'],
  },
  {
    key: 'tags', label: 'Tags', type: 'text', max: MAX_SHORT,
    aliases: ['tags', 'tag', 'labels', 'keywords', 'keywords2', 'schlagworte', 'stichworte',
      '标签', '標籤', '關鍵字'],
  },
  {
    key: 'ingredients', label: 'Ingredients', type: 'text', max: MAX_TEXT,
    aliases: ['ingredients', 'ingredient', 'items', 'materials', 'zutaten',
      '食材', '材料', '原料'],
  },
];

/**
 * 可导入模块注册表。
 * `table` 供幂等登记写明实体归属；writer 名写在注释里，避免和 runner 的
 * 实现清单双份维护失同步（runner 会有一处穷举校验）。
 */
export const IMPORT_MODULES = Object.freeze([
  {
    key: 'tasks',
    table: 'tasks',
    label: 'Tasks',
    hint: 'CSV 表头如 Title / Due Date / Priority；每行一条任务。',
    fields: Object.freeze(TASK_FIELDS),
  },
  {
    key: 'contacts',
    table: 'contacts',
    label: 'Contacts',
    hint: '电话与地址在系统内以 SM4 加密存储，导入时自动加密。',
    fields: Object.freeze(CONTACT_FIELDS),
  },
  {
    key: 'shopping',
    table: 'shopping_items',
    label: 'Shopping',
    hint: '每行一件商品；List 列不存在时自动新建同名清单。',
    fields: Object.freeze(SHOPPING_FIELDS),
  },
  {
    key: 'recipes',
    table: 'recipes',
    label: 'Recipes',
    hint: 'Ingredients 列支持「番茄|2个|蔬菜」写法，多个食材用分号或换行分隔。',
    fields: Object.freeze(RECIPE_FIELDS),
  },
  // 扩展位：预算(budget_transactions) / 影音(media_items) 尚未实现 writer，
  // 追加时 ①在这里加一项 ②在 import-runner.js 的 WRITERS 里登记同名函数。
  // 预览、列映射、幂等登记、历史记录全部由这两个入口自动带出来。
]);

/** 模块 key 的快速索引。 */
const MODULE_INDEX = new Map(IMPORT_MODULES.map((mod) => [mod.key, mod]));

/**
 * 取模块定义，未知 key 返回 null。
 * @param {string} key
 * @returns {typeof IMPORT_MODULES[number]|null}
 */
export function getImportModule(key) {
  return MODULE_INDEX.get(String(key ?? '').trim()) ?? null;
}

/** 前端用：模块清单（可 JSON 序列化）。 */
export function listImportModules() {
  return IMPORT_MODULES.map((mod) => ({
    key: mod.key,
    label: mod.label,
    hint: mod.hint,
    fields: mod.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: Boolean(field.required),
      enumValues: field.enumValues ?? null,
    })),
  }));
}

/** 别名 → 字段 key 的反查表（每个模块构建一次，模块级缓存）。 */
const ALIAS_INDEX = new Map(IMPORT_MODULES.map((mod) => {
  const index = new Map();
  for (const field of mod.fields) {
    index.set(field.key, field.key); // 目标字段名本身也算别名，便于幂等重跑
    for (const alias of field.aliases ?? []) index.set(alias, field.key);
  }
  return [mod.key, index];
}));

/**
 * 依据源表头自动推断列映射。
 * 逐个表头查别名表；命中且该目标字段尚未占用时写入映射，否则留空由用户手选。
 *
 * @param {string} moduleKey
 * @param {string[]} headers 源文件的列标题
 * @returns {{mapping: Record<string, number>, matched: string[], unmatched: string[]}}
 *          mapping 形如 { title: 0, due_date: 3 }
 */
export function autoMapHeaders(moduleKey, headers) {
  const index = ALIAS_INDEX.get(moduleKey);
  /** @type {Record<string, number>} */
  const mapping = {};
  const matched = [];
  const unmatched = [];
  if (!index) return { mapping, matched, unmatched };

  for (let column = 0; column < headers.length; column += 1) {
    const normalized = normalizeHeader(headers[column]);
    if (!normalized) continue;
    const fieldKey = index.get(normalized);
    if (fieldKey && mapping[fieldKey] === undefined) {
      mapping[fieldKey] = column;
      matched.push(headers[column]);
    } else {
      unmatched.push(headers[column]);
    }
  }

  return { mapping, matched, unmatched };
}

// ------------------------------------------------------------
// 取值规范化（coerce）
// ------------------------------------------------------------

/** 补齐月/日为两位。 */
function pad(value) { return String(value).padStart(2, '0'); }

/** 日期是否真实存在（挡住 2026-02-31 这类脏数据）。 */
function isRealDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/**
 * 日期归一化 → 'YYYY-MM-DD'。
 * 支持：ISO(含时间前缀)、斜杠/点分隔、中文年月日、YYYYMMDD。
 * 两位年份不猜：直接判为非法（歧义太大，宁可让用户在预览里看到错误行）。
 * @param {string} raw
 * @returns {string|null} 合法则返回 ISO 日期，否则 null
 */
export function normalizeDate(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (!match) match = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(text);
  if (!match) {
    // DD.MM.YYYY / D-M-YYYY —— 德国导出最常见，日在前；首位 > 12 时必然是日。
    const euro = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/.exec(text);
    if (euro) {
      const [, first, second, year] = euro;
      const day = Number(first);
      const month = Number(second);
      if (isRealDate(Number(year), month, day)) return `${year}-${pad(month)}-${pad(day)}`;
      return null;
    }
    const cn = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/.exec(text);
    if (cn) {
      const [, year, month, day] = cn;
      if (isRealDate(Number(year), Number(month), Number(day))) {
        return `${year}-${pad(month)}-${pad(day)}`;
      }
      return null;
    }
    if (/^\d{8}$/.test(text)) {
      const year = text.slice(0, 4);
      const month = text.slice(4, 6);
      const day = text.slice(6, 8);
      if (isRealDate(Number(year), Number(month), Number(day))) return `${year}-${month}-${day}`;
      return null;
    }
    return null;
  }

  const [, year, month, day] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (!isRealDate(y, m, d)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * 时间归一化 → 'HH:MM'。空值返回 null（不合法才返回 undefined 标记失败，
 * 用 {ok:false} 区分「没填」和「填错了」这两种完全不同的结果）。
 * @param {string} raw
 * @returns {{ok: boolean, value: string|null}}
 */
export function normalizeTime(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: null };

  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text);
  if (!match) return { ok: false, value: null };

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = (match[4] || '').toLowerCase();
  if (minutes > 59) return { ok: false, value: null };
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23) return { ok: false, value: null };

  return { ok: true, value: `${pad(hours)}:${pad(minutes)}` };
}

/**
 * 非负整数归一化（份数/时长）。空值 → null（合法），非数字 → 失败。
 * @param {string} raw
 * @returns {{ok: boolean, value: number|null}}
 */
export function normalizeNumber(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: null };
  // 「30 分钟」「3-4人」这类半结构化文本：取第一段数字
  const match = /^(\d{1,5})/.exec(text.replace(/[.,](?=\d{3}\b)/g, ''));
  if (!match) return { ok: false, value: null };
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return { ok: false, value: null };
  return { ok: true, value };
}

/**
 * 单个单元格按目标字段类型转换。
 * @param {import('./import-mapping.js').ImportField} field
 * @param {unknown} raw
 * @returns {{ok: boolean, value: string|number|null, error?: string}}
 */
export function coerceField(field, raw) {
  const rawText = typeof raw === 'string' ? raw : (raw === null || raw === undefined ? '' : String(raw));

  switch (field.type) {
    case 'date': {
      const text = rawText.trim();
      if (!text) return { ok: true, value: null };
      const value = normalizeDate(text);
      return value ? { ok: true, value } : { ok: false, value: null, error: `invalid date "${text}"` };
    }
    case 'time': {
      const result = normalizeTime(rawText);
      return result.ok
        ? { ok: true, value: result.value }
        : { ok: false, value: null, error: `invalid time "${rawText.trim()}"` };
    }
    case 'number': {
      const result = normalizeNumber(rawText);
      return result.ok
        ? { ok: true, value: result.value }
        : { ok: false, value: null, error: `invalid number "${rawText.trim()}"` };
    }
    case 'enum': {
      const text = rawText.trim();
      if (!text) return { ok: true, value: null };
      const normalized = text.toLowerCase().replace(/[\s_-]+/g, '');
      const mapped = (field.enumMap ?? {})[normalized]
        ?? (field.enumMap ?? {})[text.toLowerCase()]
        ?? null;
      const fallback = (field.enumValues ?? []).includes(normalized) ? normalized : null;
      const value = mapped ?? fallback;
      if (!value || !(field.enumValues ?? []).includes(value)) {
        return { ok: false, value: null, error: `unknown ${field.key} "${text}"` };
      }
      return { ok: true, value };
    }
    default: {
      const text = rawText.trim();
      if (field.max && text.length > field.max) {
        return { ok: true, value: text.slice(0, field.max) };
      }
      return { ok: true, value: text || null };
    }
  }
}

/**
 * 把「原始行」按列映射翻译成一组可校验的记录。
 *
 * 每一行独立处理：某行的某个字段不合法只让**这一行**失败，不会污染其余行，
 * 也不抛异常（调用方拿到的是带 reasons 的记录）。
 *
 * @param {string} moduleKey
 * @param {{cells: string[], rowNumber: number}[]} rows
 * @param {Record<string, number>} mapping 目标字段 → 源列下标
 * @returns {{record: Record<string, unknown>, rowNumber: number, errors: string[]}[]}
 */
export function buildRecords(moduleKey, rows, mapping) {
  const module = getImportModule(moduleKey);
  if (!module) return [];

  return rows.map(({ cells, rowNumber }) => {
    /** @type {Record<string, unknown>} */
    const record = {};
    const errors = [];

    for (const field of module.fields) {
      const column = mapping?.[field.key];
      if (column === undefined || column === null || column < 0) continue;
      const result = coerceField(field, cells[column]);
      if (!result.ok) {
        errors.push(`${field.label}: ${result.error}`);
        continue;
      }
      record[field.key] = result.value;
    }

    for (const field of module.fields) {
      if (!field.required) continue;
      const value = record[field.key];
      if (value === null || value === undefined || String(value).trim() === '') {
        errors.push(`${field.label}: required`);
      }
    }

    return { record, rowNumber, errors };
  });
}
