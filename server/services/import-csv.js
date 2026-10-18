/**
 * Modul: CSV-Parser（零依赖实现）
 * Zweck: 通用导入工具的文本解析层 —— 不引入任何 npm 依赖，手写状态机。
 *
 * 必须正确处理的四种情况（Notion/飞书/手机备忘录/Google Calendar 导出的
 * CSV 全部会踩到至少一个）：
 *   1. 引号包裹字段内的分隔符：`"Müller, Anna"` 不能被切成两列
 *   2. 引号包裹字段内的换行：多行备注必须留在同一单元格里
 *   3. 转义双引号：`"er sagte ""Hallo"""` → `er sagte "Hallo"`
 *   4. UTF-8 BOM、CRLF(\r\n) / CR(\r) / LF(\n) 三种行尾并存
 *
 * 设计约定：
 *   - 纯函数，输入字符串，输出二维数组；不读文件、不碰数据库。
 *   - 永不抛错：坏输入返回空结果，由调用方决定如何提示（符合项目「外部
 *     输入静默降级」的一贯做法）。
 *   - 仅支持单字符分隔符；未显式指定时按首行出现频率自动识别 , ; \t |
 */

/** UTF-8 BOM 字符（Excel / 记事本导出的标配）。 */
const BOM = '﻿';

/** 参与自动识别的候选分隔符，按服务端常见度排序（并列时靠前者胜出）。 */
const DELIMITER_CANDIDATES = [',', ';', '\t', '|'];

/**
 * 去掉开头的 UTF-8 BOM。没有 BOM 时原样返回。
 * @param {string} text
 * @returns {string}
 */
export function stripBom(text) {
  return typeof text === 'string' && text.startsWith(BOM) ? text.slice(1) : text;
}

/**
 * 统计第一个逻辑行（含引号内换行）中各候选分隔符的出现次数。
 * 只看首行：表头一定在第一行，扫全文既慢又会被正文干扰。
 * @param {string} text 已去 BOM 的原文
 * @returns {Record<string, number>}
 */
function countDelimiters(text) {
  const counts = Object.fromEntries(DELIMITER_CANDIDATES.map((d) => [d, 0]));
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        // "" 是转义的双引号，不是字段结束
        if (text[i + 1] === '"') i += 1;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === '\n' || ch === '\r') break; // 首行结束
    if (counts[ch] !== undefined) counts[ch] += 1;
  }

  return counts;
}

/**
 * 推断分隔符：首行出现次数最多的候选；全为 0 时回退到逗号。
 * @param {string} text
 * @returns {string} 单字符分隔符
 */
export function detectDelimiter(text) {
  const counts = countDelimiters(String(text ?? ''));
  let best = ',';
  let bestCount = -1;
  for (const delimiter of DELIMITER_CANDIDATES) {
    if (counts[delimiter] > bestCount) {
      best = delimiter;
      bestCount = counts[delimiter];
    }
  }
  return bestCount > 0 ? best : ',';
}

/**
 * CSV → 二维数组（详细结果）。
 *
 * 状态机说明（为什么不能用 split(',')）：
 *   quotedField  当前处于引号段，段内的分隔符与换行都算字面量
 *   quotedPending 刚从引号段出来，此时再遇到 " 视为普通字符，不再开启新引号段
 *                 （`"a"b"` 这类脏数据不会把解析器带偏）
 *
 * @param {string} input 原始文件内容
 * @param {{delimiter?: string}} [options]
 * @returns {{rows: string[][], delimiter: string}}
 */
export function parseCsvDetailed(input, options = {}) {
  const text = stripBom(String(input ?? ''));
  const explicit = typeof options.delimiter === 'string' && options.delimiter.length === 1
    ? options.delimiter
    : null;
  const delimiter = explicit ?? detectDelimiter(text);

  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let quotedField = false;
  let quotedPending = false;
  let touched = false; // 当前行是否已经有内容（用于丢弃文件末尾的空行）

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (quotedField) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quotedField = false;
        quotedPending = true;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    // 字段起始位置的引号才表示「引号段开始」
    if (ch === '"' && !quotedPending && field === '') {
      quotedField = true;
      touched = true;
      i += 1;
      continue;
    }

    if (ch === delimiter) {
      row.push(field);
      touched = true;
      field = '';
      quotedPending = false;
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1; // CRLF 视作一个换行
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      quotedPending = false;
      touched = false;
      i += 1;
      continue;
    }

    field += ch;
    touched = true;
    i += 1;
  }

  // 文件末尾：只有确实还有内容时才收最后一行（否则 "a,b\n" 会多出一行空数据）
  if (touched || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return { rows, delimiter };
}

/**
 * CSV → 二维数组（便捷封装）。
 * @param {string} input
 * @param {{delimiter?: string}} [options]
 * @returns {string[][]}
 */
export function parseCsv(input, options = {}) {
  return parseCsvDetailed(input, options).rows;
}

/**
 * 二维数组 → 对象数组。第一行为表头（或由外部传入的表头）。
 * 无表头时列名退化为 column_1 … column_n，保证后续（照样值与列映射）
 * 有一条统一的取值路径。
 *
 * @param {string[][]} rows
 * @param {{headers?: string[], hasHeader?: boolean}} [options]
 * @returns {{headers: string[], records: Record<string, string>[]}}
 */
export function rowsToRecords(rows, options = {}) {
  const hasHeader = options.hasHeader !== false;
  const source = Array.isArray(rows) ? rows : [];
  if (source.length === 0) return { headers: [], records: [] };

  const rawHeaders = Array.isArray(options.headers) && options.headers.length > 0
    ? options.headers.slice()
    : (hasHeader ? source[0] : null);
  const dataRows = hasHeader && !options.headers ? source.slice(1) : source;

  const headers = (rawHeaders ?? []).map((name, index) => {
    const cleaned = String(name ?? '').trim();
    return cleaned || `column_${index + 1}`;
  });
  const fallback = dataRows[0]?.length ?? 0;
  const normalized = headers.length > 0 ? headers : Array.from({ length: fallback }, (_, idx) => `column_${idx + 1}`);

  const records = dataRows.map((cells) => {
    /** @type {Record<string, string>} */
    const record = {};
    for (let index = 0; index < normalized.length; index += 1) {
      record[normalized[index]] = String(cells?.[index] ?? '');
    }
    return record;
  });

  return { headers: normalized, records };
}

/**
 * 尝试把任意文本解析成 JSON 数组（正是 Notion / 飞书导出的 JSON 形态）。
 * 兼容三种形态：顶层数组、{ data: [...] }、{ items: [...] }。
 * 失败返回 null —— 由调用方（路由）决定降级路径，此处不抛、不猜测。
 * @param {string} input
 * @returns {Record<string, unknown>[]|null}
 */
export function parseJsonRecords(input) {
  const text = stripBom(String(input ?? '')).trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed.filter((entry) => entry && typeof entry === 'object');
  if (parsed && typeof parsed === 'object') {
    for (const key of ['data', 'items', 'results', 'rows', 'records']) {
      if (Array.isArray(parsed[key])) {
        return parsed[key].filter((entry) => entry && typeof entry === 'object');
      }
    }
  }
  return null;
}
