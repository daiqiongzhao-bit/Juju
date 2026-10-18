/**
 * Modul: 导入执行器（Import Runner）
 * Zweck: 把「已翻译好的行」写进数据库 —— 逐行容错 + 幂等登记 + dry_run 预演。
 *
 * 三条硬性行为：
 *   1. 单行失败不影响其余行：每行独立 commit，坏行进 failures 明细，
 *      不会因为一行脏数据把整批回滚（导入 500 行时用户只想看到失败的 3 行）。
 *   2. 幂等：每行算出内容指纹写进 import_row_map（module+fingerprint 唯一
 *      索引）。同一份文件再导一次只计 skipped，不会复制出第二份数据。
 *   3. dry_run：完全不写业务表，也不登记指纹，只报告「会发生什么」。
 *
 * Abhängigkeiten: node:crypto, server/db.js, services/sm4.js,
 *                public/utils/recipe-meal-types.js
 */

import crypto from 'node:crypto';

import * as db from '../db.js';
import { encryptField, phoneHash } from './sm4.js';
import { getImportModule } from './import-mapping.js';
import { normalizeRecipeMealTypes } from '../../public/utils/recipe-meal-types.js';
import { createLogger } from '../logger.js';

const log = createLogger('Import');

/** 单次导入的行数上限：既是性能护栏，也是误传整本通讯录时的刹车。 */
export const MAX_ROWS = 20000;

/** 未提供清单名时的兜底清单名。 */
const FALLBACK_LIST_NAME = 'Imported';

/**
 * 行内容指纹：module + 已翻译记录里所有非空字段的稳定 JSON（SHA-256）。
 * 排序后的键序列保证「同一行数据」永远同一指纹，与列顺序无关。
 *
 * @param {string} moduleKey
 * @param {Record<string, unknown>} record
 * @returns {string} hex 指纹
 */
export function fingerprint(moduleKey, record) {
  const entries = Object.entries(record)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const payload = JSON.stringify({ module: moduleKey, fields: entries });
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ------------------------------------------------------------
// 食材串解析（菜谱专用）
// ------------------------------------------------------------

/** 条目之间的分隔符：换行、分号（半角/全角）、竖线流。 */
const INGREDIENT_SEPARATORS = /[\n;；｜]+/;

/**
 * 单个食材条目 → {name, quantity, category}。
 * 支持三种写法（按优先级）：
 *   ① `番茄|2个|蔬菜`      竖线分段的完整写法
 *   ② `番茄|2个`           省掉分类
 *   ③ `2个 番茄`           数量在前（中文笔记导出最常见）
 *   ④ `番茄`               只有名字
 * 解析不出名字时返回 null（调用方跳过该条，不因此废掉整行）。
 *
 * @param {string} entry
 * @returns {{name: string, quantity: string|null, category: string}|null}
 */
export function parseIngredientEntry(entry) {
  let text = String(entry ?? '').trim();
  if (!text) return null;
  // 列表导出常带的项目符号前缀
  text = text.replace(/^[-*•·]\s+/, '').trim();
  if (!text) return null;

  const parts = text.split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const [name, quantity = '', category = ''] = parts;
    return {
      name: name.slice(0, 200),
      quantity: quantity || null,
      category: category || 'Sonstiges',
    };
  }

  // 数量在前：「2个 鸡蛋」/「1.5 tbsp olive oil」
  const leading = /^(\d+(?:[.,]\d+)?\s*\S*)\s+(.+)$/.exec(text);
  if (leading) {
    return {
      name: leading[2].trim().slice(0, 200),
      quantity: leading[1].trim() || null,
      category: 'Sonstiges',
    };
  }

  return { name: text.slice(0, 200), quantity: null, category: 'Sonstiges' };
}

/**
 * 整列食材文本 → 食材数组。空输入返回空数组（不是错误：很多 CSV 没有食材列）。
 * @param {unknown} value
 * @returns {{name: string, quantity: string|null, category: string}[]}
 */
export function parseIngredients(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const result = [];
  for (const entry of text.split(INGREDIENT_SEPARATORS)) {
    const parsed = parseIngredientEntry(entry);
    if (parsed) result.push(parsed);
  }
  return result;
}

/** 餐次别名 → 规范键（normalizeRecipeMealTypes 只认英文键）。 */
const MEAL_TYPE_ALIASES = {
  breakfast: 'breakfast', fruehstueck: 'breakfast', frühstück: 'breakfast', morning: 'breakfast',
  lunch: 'lunch', mittagessen: 'lunch', mittag: 'lunch', noon: 'lunch',
  dinner: 'dinner', abendessen: 'dinner', abendbrot: 'dinner', supper: 'dinner',
  snack: 'snack', snacks: 'snack', dessert: 'snack', zwischenmahlzeit: 'snack',
  早餐: 'breakfast', 早饭: 'breakfast', 早点: 'breakfast',
  午餐: 'lunch', 午饭: 'lunch', 中餐: 'lunch',
  晚餐: 'dinner', 晚饭: 'dinner', 正餐: 'dinner',
  加餐: 'snack', 零食: 'snack', 点心: 'snack', 甜点: 'snack',
};

/**
 * 餐次文本 → 逗号分隔的规范值（非法/空 → 全部四种，与菜谱路由默认值一致）。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeMealTypes(value) {
  const text = String(value ?? '').trim();
  if (!text) return normalizeRecipeMealTypes(null).join(',');
  const parts = text.split(/[,;，、\s]+/).map((part) => part.trim()).filter(Boolean);
  const mapped = parts.map((part) => MEAL_TYPE_ALIASES[part.toLowerCase()] ?? null).filter(Boolean);
  const source = mapped.length ? mapped : parts;
  return normalizeRecipeMealTypes(source.join(',')).join(',');
}

/** 标签串 → 逗号分隔（兼容中英文逗号/分号/顿号）。 */
export function normalizeTags(value) {
  const parts = String(value ?? '')
    .split(/[,;，、;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return [...new Set(parts)].join(',') || null;
}

// ------------------------------------------------------------
// 各模块的写入函数
// ------------------------------------------------------------

/**
 * 取一列 safely：better-sqlite3 在缺列时抛错，导入期间表结构是确定的，
 * 这里只为把异常收敛成「该行失败」而不是整批崩掉。
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {any}
 */
function run(sql, params = []) {
  return db.get().prepare(sql).run(...params);
}

/** tasks：默认 open/none/Sonstiges，缺失值用数据库默认值兜住。 */
function writeTask(record, userId) {
  const result = run(`
    INSERT INTO tasks (title, description, category, priority, status, due_date, due_time, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.title,
    record.description ?? null,
    record.category || 'Sonstiges',
    record.priority || 'none',
    record.status || 'open',
    record.due_date ?? null,
    record.due_time ?? null,
    userId,
  ]);
  return { table: 'tasks', id: Number(result.lastInsertRowid) };
}

/** contacts：phone/address 是 SM4 密文列，必须走 encryptField（同 routes/contacts.js）。 */
function writeContact(record, userId) {
  const phonePlain = record.phone ? String(record.phone) : null;
  const addressPlain = record.address ? String(record.address) : null;
  const birthday = record.birthday ?? null;

  // contacts 表没有 created_by 列（联系人是全家人共享的地址簿，
  // routes/contacts.js 也不写这一列），这里不能照抄 tasks 的写法。
  const columns = ['name', 'category', 'email', 'notes'];
  const params = [record.name, record.category || 'Sonstiges', record.email ?? null, record.notes ?? null];

  // 可选列可能存在与否取决于迁移进度；importing 时这些列在 v>=152 一定存在。
  if (record.organization !== undefined) { columns.push('organization'); params.push(record.organization); }
  if (record.job_title !== undefined) { columns.push('job_title'); params.push(record.job_title); }
  if (record.nickname !== undefined) { columns.push('nickname'); params.push(record.nickname); }
  if (birthday !== null) { columns.push('birthday'); params.push(birthday); }
  if (phonePlain !== null) {
    columns.push('phone', 'phone_hash');
    params.push(encryptField(phonePlain), phoneHash(phonePlain));
  }
  if (addressPlain !== null) {
    columns.push('address');
    params.push(encryptField(addressPlain));
  }

  const placeholders = columns.map(() => '?').join(', ');
  const result = db.get()
    .prepare(`INSERT INTO contacts (${columns.join(', ')}) VALUES (${placeholders})`)
    .run(...params);
  return { table: 'contacts', id: Number(result.lastInsertRowid) };
}

/** shopping：清单按名查找（大小写不敏感），没有则顺手新建。 */
function writeShoppingItem(record, userId, fallbackListName) {
  const listName = String(record.list ?? '').trim() || fallbackListName;
  let listId = db.get()
    .prepare('SELECT id FROM shopping_lists WHERE name COLLATE NOCASE = ? ORDER BY id ASC LIMIT 1')
    .get(listName)?.id ?? null;

  if (listId === null) {
    listId = Number(run(
      'INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)',
      [listName, userId],
    ).lastInsertRowid);
  }

  const result = run(`
    INSERT INTO shopping_items (list_id, name, quantity, category, notes)
    VALUES (?, ?, ?, ?, ?)
  `, [
    listId,
    record.name,
    record.quantity ?? null,
    record.category || 'Sonstiges',
    record.notes ?? null,
  ]);
  return { table: 'shopping_items', id: Number(result.lastInsertRowid), listName };
}

/** recipes：主表 + 食材明细，一次行事务里写完。 */
function writeRecipe(record, userId) {
  const result = run(`
    INSERT INTO recipes (title, notes, recipe_url, meal_types, servings, duration_minutes, tags, ai_generated, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `, [
    record.title,
    record.notes ?? null,
    record.recipe_url ?? null,
    normalizeMealTypes(record.meal_types),
    record.servings ?? null,
    record.duration_minutes ?? null,
    normalizeTags(record.tags),
    userId,
  ]);

  const recipeId = Number(result.lastInsertRowid);
  const insertIngredient = db.get().prepare(`
    INSERT INTO recipe_ingredients (recipe_id, name, quantity, category)
    VALUES (?, ?, ?, ?)
  `);
  const ingredients = parseIngredients(record.ingredients);
  for (const ingredient of ingredients) {
    insertIngredient.run(recipeId, ingredient.name, ingredient.quantity, ingredient.category);
  }

  return { table: 'recipes', id: recipeId, ingredients: ingredients.length };
}

/**
 * 模块 → 写入函数。新增模块时在这里登记一项即可（与 import-mapping.js 的
 * IMPORT_MODULES 一一对应，缺失会以「该行失败」的形式暴露而不是静默丢弃）。
 */
const WRITERS = {
  tasks: writeTask,
  contacts: writeContact,
  shopping: writeShoppingItem,
  recipes: writeRecipe,
};

// ------------------------------------------------------------
// 主入口
// ------------------------------------------------------------

/** 幂等登记是否已存在（同一 module + fingerprint）。 */
function findExisting(moduleKey, hash) {
  return db.get()
    .prepare('SELECT id, entity_id FROM import_row_map WHERE module = ? AND fingerprint = ?')
    .get(moduleKey, hash) ?? null;
}

/**
 * 执行导入。
 *
 * @param {Object} options
 * @param {string} options.moduleKey      目标模块
 * @param {{rowNumber: number, record: Record<string, unknown>, errors: string[]}[]} options.records
 *        已经过列映射与类型转换的行（buildRecords 的输出）
 * @param {boolean} [options.dryRun]      预演模式：不落库
 * @param {boolean} [options.skipDuplicates] 幂等开关（默认 true）
 * @param {string|null} [options.fileName] 仅用于购物清单兜底名与批次记录
 * @param {number|null} [options.userId]  操作者
 * @returns {{module: string, dryRun: boolean, total: number, created: number, skipped: number,
 *           failed: number, failures: {row: number, reason: string}[], batchId: number|null,
 *           warnings: string[]}}
 */
export function runImport(options) {
  const {
    moduleKey,
    records = [],
    dryRun = false,
    skipDuplicates = true,
    fileName = null,
    userId = null,
  } = options;

  const module = getImportModule(moduleKey);
  if (!module) {
    throw Object.assign(new Error('Unknown import module'), { code: 'UNKNOWN_MODULE' });
  }

  const warnings = [];
  const failures = [];
  let total = 0;
  let created = 0;
  let skipped = 0;
  let failed = 0;

  let rows = Array.isArray(records) ? records : [];
  if (rows.length > MAX_ROWS) {
    warnings.push(`Only the first ${MAX_ROWS} rows were processed (file has ${rows.length}).`);
    rows = rows.slice(0, MAX_ROWS);
  }

  const fallbackListName = String(fileName ?? '').replace(/\.[^.]+$/, '').trim() || FALLBACK_LIST_NAME;

  // 批次头：dry_run 也要留痕，方便「预演过、忘了吗」的自查。
  const batchId = dryRun ? null : Number(run(`
    INSERT INTO import_batches (module, file_name, dry_run, rows_total, created_rows, skipped_rows, failed_rows, created_by)
    VALUES (?, ?, 0, ?, 0, 0, 0, ?)
  `, [moduleKey, fileName ?? null, rows.length, userId]).lastInsertRowid);

  const markMap = db.get().prepare(`
    INSERT OR IGNORE INTO import_row_map (module, fingerprint, entity_table, entity_id, batch_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const entry of rows) {
    total += 1;

    // ① 行级校验错误（required 缺失、日期非法等）——不重试，直接记明细。
    if (entry.errors?.length) {
      failed += 1;
      failures.push({ row: entry.rowNumber, reason: entry.errors.join('; ') });
      continue;
    }

    // ② 幂等：指纹命中且 skipDuplicates 时跳过，绝不产生第二条副本。
    const hash = fingerprint(moduleKey, entry.record);
    if (skipDuplicates) {
      let existing = null;
      try {
        existing = findExisting(moduleKey, hash);
      } catch (err) {
        // 指纹表异常不应让整批失败：降级为「允许重复」，并给出告警。
        warnings.push('Duplicate detection unavailable for this batch.');
        log.error('import_row_map lookup failed:', err?.message || err);
      }
      if (existing) {
        skipped += 1;
        continue;
      }
    }

    if (dryRun) {
      created += 1;
      continue;
    }

    // ③ 写入：整行包在一个事务里 —— 行内多表（菜谱+食材）原子，跨行互不影响。
    try {
      const writer = WRITERS[moduleKey];
      if (!writer) throw new Error(`No writer implemented for module "${moduleKey}"`);

      // Achtung: db.transaction(fn) führt fn bereits aus (siehe server/db.js) —
      // sie liefert das Ergebnis, KEINE aufrufbare Funktion zurück.
      const written = db.transaction(() => {
        const result = writer(entry.record, userId, fallbackListName);
        markMap.run(moduleKey, hash, result.table, result.id, batchId);
        return result;
      });

      if (written) created += 1;
    } catch (err) {
      failed += 1;
      const reason = String(err?.message || err).slice(0, 300);
      failures.push({ row: entry.rowNumber, reason });
      log.warn(`Import row ${entry.rowNumber} failed (${moduleKey}): ${reason}`);
    }
  }

  if (batchId !== null) {
    try {
      db.get().prepare(`
        UPDATE import_batches SET rows_total = ?, created_rows = ?, skipped_rows = ?, failed_rows = ?
        WHERE id = ?
      `).run(total, created, skipped, failed, batchId);
    } catch (err) {
      log.error('Failed to finalize import batch:', err?.message || err);
    }
  }

  return { module: moduleKey, dryRun: Boolean(dryRun), total, created, skipped, failed, failures, batchId, warnings };
}

/**
 * 最近若干次导入批次（历史追溯：谁在什么时候导了多少行）。
 * @param {number} [limit]
 * @returns {Object[]}
 */
export function recentBatches(limit = 20) {
  try {
    return db.get().prepare(`
      SELECT b.*, u.display_name AS created_by_name
      FROM import_batches b
      LEFT JOIN users u ON u.id = b.created_by
      ORDER BY b.id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(Number(limit) || 20, 100)));
  } catch (err) {
    log.error('Failed to read import history:', err?.message || err);
    return [];
  }
}
