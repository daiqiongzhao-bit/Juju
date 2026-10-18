/**
 * Modul: AI 菜谱生成（OpenAI 兼容 /chat/completions）
 * Zweck: 应用内的 AI 入口 —— 把一句自然语言需求变成结构化菜谱。
 *
 * 三条硬约束（照抄 services/media-metadata.js 的「外部调用」范式）：
 *   1. 原生 fetch + AbortController 超时（默认 30 s），零新增依赖。
 *   2. **失败静默降级**：未配置、超时、4xx/5xx、模型返回非法 JSON
 *      —— 一律返回 { ok:false, code, message }，**绝不把原始堆栈或上游响应体
 *      原样抛到界面**（详情只进服务端日志）。
 *   3. 密钥只从数据库读（services/ai-config.js），永远不接受前端传来的 Key。
 *
 * 传输用 OpenAI 兼容最小集 { model, messages, temperature }；
 * 解析层的纯函数住在 services/ai-recipe-parse.js（那里没有数据库依赖，
 * 因此可以脱离 Node 22 单独测试）。
 *
 * Abhängigkeiten: services/ai-config.js, services/ai-recipe-parse.js, server/logger.js
 */

import { getConfig, providerByKey } from './ai-config.js';
import { extractJsonObject, normalizeAiRecipe, endpointUrl } from './ai-recipe-parse.js';
import { createLogger } from '../logger.js';

const log = createLogger('AIRecipe');

/** 单次生成超时（毫秒）。一顿家常菜不该让用户等更久。 */
export const AI_TIMEOUT_MS = 30000;

/** 连通性测试的超时：只问一个词，给太长时间没意义。 */
export const AI_TEST_TIMEOUT_MS = 15000;

/** 用户需求的最大长度，超出直接拒（同时避免巨额 token 账单）。 */
export const MAX_PROMPT_LENGTH = 2000;

/**
 * System prompt：只要求 JSON，并明确写下字段名（中英文混排的大模型环境下，
 * 字段名写得越具体，返回越稳定）。解析失败也不怕 —— 下面还有纯文本降级。
 */
const SYSTEM_PROMPT = [
  'You are a helpful family kitchen assistant.',
  'Answer ONLY with a JSON object, no markdown fences, no commentary.',
  'JSON shape:',
  '{"title": string, "servings": number, "duration_minutes": number,',
  ' "tags": string[], "ingredients": [{"name": string, "quantity": string, "category": string}],',
  ' "steps": string[]}',
  'Rules: steps are short imperative sentences in the user\'s language;',
  'quantity must include a unit (e.g. "2 pcs", "200 g");',
  'category is a shopping aisle (Sonstiges is fine).',
].join(' ');

/**
 * 统一的 /chat/completions 调用。
 * 永不 throw：所有失败都变成 { ok:false, code, message }。
 *
 * @param {{url: string, apiKey: string, model: string, userPrompt: string,
 *          timeoutMs?: number, temperature?: number, systemPrompt?: string}} options
 * @returns {Promise<{ok: boolean, content?: string, code?: string, message?: string,
 *                    status?: number, latencyMs: number}>}
 */
async function chatComplete(options) {
  const {
    url, apiKey, model, userPrompt,
    timeoutMs = AI_TIMEOUT_MS,
    temperature = 0.7,
    systemPrompt = SYSTEM_PROMPT,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
      }),
    });

    if (!response.ok) {
      // 上游的错误文本可能很长也可能夹带敏感片段：只取前 200 字符进日志。
      const detail = await response.text().catch(() => '');
      log.warn('AI request failed', response.status, String(detail).slice(0, 200));
      return {
        ok: false,
        code: response.status === 401 || response.status === 403 ? 'auth' : 'http',
        message: 'The AI provider rejected the request.',
        status: response.status,
        latencyMs: Date.now() - startedAt,
      };
    }

    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    return {
      ok: true,
      content: typeof content === 'string' ? content : '',
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || String(err?.message ?? '').includes('aborted');
    log.warn('AI request error:', err?.message || err);
    return {
      ok: false,
      code: aborted ? 'timeout' : 'network',
      message: aborted ? 'The AI provider did not answer in time.' : 'The AI provider could not be reached.',
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析当前配置，给出可直接调用的三要素；配置不可用时返回结构化原因。
 * @returns {{ok: true, url: string, apiKey: string, model: string}|{ok: false, code: string, message: string}}
 */
function resolveTarget() {
  const cfg = getConfig();
  const url = endpointUrl(cfg.baseUrl || providerByKey(cfg.provider).baseUrl);
  if (!cfg.enabled) return { ok: false, code: 'disabled', message: 'AI recipes are switched off.' };
  if (!url) return { ok: false, code: 'no_config', message: 'No endpoint is configured.' };
  if (!cfg.apiKey) return { ok: false, code: 'no_key', message: 'No API key is configured.' };
  if (!cfg.model) return { ok: false, code: 'no_model', message: 'No model is configured.' };
  return { ok: true, url, apiKey: cfg.apiKey, model: cfg.model };
}

/**
 * 生成菜谱。
 *
 * @param {{prompt?: string, servings?: number|null}} [options]
 * @returns {Promise<{ok: boolean, mode?: 'json'|'text', recipe?: object, rawText?: string,
 *                    code?: string, message?: string}>}
 */
export async function generateRecipe(options = {}) {
  const target = resolveTarget();
  if (!target.ok) return { ok: false, code: target.code, message: target.message };

  const prompt = String(options.prompt ?? '').trim();
  if (!prompt) return { ok: false, code: 'empty_prompt', message: 'Please describe what you want to cook.' };
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return { ok: false, code: 'prompt_too_long', message: 'The request is too long.' };
  }

  const servingsHint = Number.isFinite(Number(options.servings)) && Number(options.servings) > 0
    ? `\nTarget servings: ${Math.round(Number(options.servings))}.`
    : '';

  const result = await chatComplete({
    url: target.url,
    apiKey: target.apiKey,
    model: target.model,
    userPrompt: `${prompt}${servingsHint}`,
    timeoutMs: AI_TIMEOUT_MS,
  });

  if (!result.ok) return { ok: false, code: result.code, message: result.message };

  const content = String(result.content ?? '').trim();
  if (!content) return { ok: false, code: 'empty_response', message: 'The AI returned an empty answer.' };

  const parsed = extractJsonObject(content);
  const recipe = parsed ? normalizeAiRecipe(parsed) : null;

  if (recipe) return { ok: true, mode: 'json', recipe };

  // 降级：模型没按约定返回 JSON —— 把原文交给前端只读展示，由用户决定怎么用。
  // 这比一句「出错了」有用得多，也避免丢掉付费换来的内容。
  log.warn('AI recipe JSON parse failed - falling back to plain text.');
  return { ok: true, mode: 'text', rawText: content.slice(0, 8000) };
}

/**
 * 连通性测试（设置页「测试连接」按钮）。
 * 只问一个词：验证 Base URL、Key、模型三件事能否串起来。
 *
 * @returns {Promise<{ok: boolean, latencyMs?: number, model?: string, sample?: string,
 *                    code?: string, message?: string}>}
 */
export async function testConnection() {
  const target = resolveTarget();
  if (!target.ok) return { ok: false, code: target.code, message: target.message };

  const result = await chatComplete({
    url: target.url,
    apiKey: target.apiKey,
    model: target.model,
    userPrompt: 'Reply with the single word: ok',
    systemPrompt: 'You answer with exactly one word.',
    timeoutMs: AI_TEST_TIMEOUT_MS,
    temperature: 0,
  });

  if (!result.ok) return { ok: false, code: result.code, message: result.message };

  return {
    ok: true,
    latencyMs: result.latencyMs,
    model: target.model,
    sample: String(result.content ?? '').trim().slice(0, 120),
  };
}
