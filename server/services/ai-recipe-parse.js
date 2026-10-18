/**
 * Modul: KI-Antwort解析（纯函数层）
 * Zweck: 把模型返回的文本变成结构化菜谱。刻意**不 import 数据库**，
 *        这样这一层既能在纯 Node 下被单元测试覆盖（不需要 Node 22 的
 *        better-sqlite3），也能被别的传输方式（将来的 MCP、CLI）复用。
 *
 * 边界：所有函数都是宽容的 —— 脏数据返回 null / 空数组，绝不抛异常。
 *      「模型没按格式回答」是常态，不是异常。
 */

/**
 * 拼出请求地址：用户自填的 Base URL 优先，已经以 /chat/completions 结尾时
 * 不再重复拼接。空输入返回 null（表示「没配端点」）。
 * @param {string} effectiveBaseUrl
 * @returns {string|null}
 */
export function endpointUrl(effectiveBaseUrl) {
  const base = String(effectiveBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return null;
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

/**
 * 从模型回复里挖出 JSON 对象：
 *   ① 去掉 ```json … ``` 代码围栏
 *   ② 从第一个 { 或 [ 开始做引号感知的配对扫描
 *   ③ 顶层是数组时取第一个对象
 * 找不到/解析不了返回 null，由调用方降级为纯文本展示。
 *
 * @param {string} text
 * @returns {Record<string, unknown>|null}
 */
export function extractJsonObject(text) {
  let cleaned = String(text ?? '').trim();
  if (!cleaned) return null;

  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(cleaned);
  if (fence) cleaned = fence[1].trim();
  if (!cleaned) return null;

  const brace = cleaned.indexOf('{');
  const bracket = cleaned.indexOf('[');
  if (brace === -1 && bracket === -1) return null;
  const begin = brace === -1 ? bracket : (bracket === -1 ? brace : Math.min(brace, bracket));
  const opening = cleaned[begin];
  const closing = opening === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = begin; index < cleaned.length; index += 1) {
    const ch = cleaned[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === opening) depth += 1;
    else if (ch === closing) {
      depth -= 1;
      if (depth === 0) { end = index; break; }
    }
  }
  if (end === -1) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(begin, end + 1));
    if (Array.isArray(parsed)) return parsed.find((entry) => entry && typeof entry === 'object') ?? null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 任意值 → 非负整数；取不到返回 null（不抛、不猜）。
 * 「30 分钟」「about 25 mins」这类半结构化文本取第一段数字。
 * @param {unknown} value
 * @returns {number|null}
 */
export function toPositiveInt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  const match = /(\d{1,5})/.exec(String(value));
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 任意值 → 字符串数组（字符串按逗号/顿号/分号切，数组原样收敛）。
 * @param {unknown} value
 * @returns {string[]}
 */
export function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  }
  return String(value ?? '')
    .split(/[,，、;；]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * 单个食材条目 → {name, quantity, category}。
 * 支持对象写法与纯字符串写法（含「鸡蛋 2 个」这种数量在后的口语写法）。
 * @param {unknown} entry
 * @returns {{name: string, quantity: string|null, category: string}|null}
 */
export function normalizeIngredient(entry) {
  if (typeof entry === 'string') {
    const name = entry.trim();
    if (!name) return null;
    const inline = /^(.+?)\s+(\d[\d.,/]*\s*\S*)$/.exec(name);
    if (inline) return { name: inline[1].trim(), quantity: inline[2].trim(), category: 'Sonstiges' };
    return { name, quantity: null, category: 'Sonstiges' };
  }
  if (!entry || typeof entry !== 'object') return null;
  const name = String(entry.name ?? entry.item ?? entry.ingredient ?? '').trim();
  if (!name) return null;
  const quantity = String(entry.quantity ?? entry.amount ?? entry.qty ?? '').trim() || null;
  const category = String(entry.category ?? entry.aisle ?? '').trim() || 'Sonstiges';
  return { name, quantity, category };
}

/**
 * 把模型返回的对象收敛成可直接落库的形状。
 * 没有标题时返回 null —— 标题为空的菜谱对用户毫无用处，宁可降级展示原文。
 *
 * @param {Record<string, unknown>} raw
 * @returns {{title: string, notes: string|null, servings: number|null, durationMinutes: number|null,
 *            tags: string[], ingredients: {name: string, quantity: string|null, category: string}[]}|null}
 */
export function normalizeAiRecipe(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const title = String(raw.title ?? raw.name ?? raw.recipe ?? raw.recipe_name ?? raw.dish ?? raw.菜名 ?? '')
    .trim()
    .slice(0, 200);
  if (!title) return null;

  const rawSteps = raw.steps ?? raw.instructions ?? raw.method ?? raw.directions ?? raw.步骤 ?? raw.做法;
  let notes = null;
  if (Array.isArray(rawSteps)) {
    notes = rawSteps
      .map((step, index) => {
        const text = String(step ?? '').trim();
        if (!text) return '';
        return /^\d+[.)、]/.test(text) ? text : `${index + 1}. ${text}`;
      })
      .filter(Boolean)
      .join('\n') || null;
  } else if (rawSteps) {
    notes = String(rawSteps).trim() || null;
  }
  if (!notes) {
    const fallback = raw.notes ?? raw.description ?? raw.说明;
    notes = fallback ? String(fallback).trim() : null;
  }

  const rawIngredients = raw.ingredients ?? raw.items ?? raw.zutaten ?? raw.食材 ?? [];
  const ingredientSource = Array.isArray(rawIngredients)
    ? rawIngredients
    : String(rawIngredients).split(/[\n;；]+/);
  const ingredients = ingredientSource
    .map((entry) => normalizeIngredient(entry))
    .filter((entry) => entry !== null)
    .slice(0, 60);

  const servings = toPositiveInt(raw.servings ?? raw.portions ?? raw.serves ?? raw.yield ?? raw.份量);
  const durationMinutes = toPositiveInt(
    raw.duration_minutes ?? raw.durationMinutes ?? raw.minutes ?? raw.total_minutes
    ?? raw.total_time ?? raw.time_minutes ?? raw.duration ?? raw.时长,
  );
  const tags = toStringArray(raw.tags ?? raw.labels ?? raw.categories).slice(0, 12);

  return {
    title,
    notes: notes ? notes.slice(0, 8000) : null,
    servings,
    durationMinutes,
    tags,
    ingredients,
  };
}
