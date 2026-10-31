/**
 * Modul: AI 模型清单动态拉取（OpenAI 兼容 GET {baseUrl}/models）
 * Zweck: 用已存的 API Key 实时从提供方端点拉取模型清单，填充设置页候选
 *        （取代 0.0.33 时代写死的 AI_PROVIDERS[].models 快照）。
 *
 * 三条硬约束（照抄 services/ai-recipe.js 的「外部调用」范式）：
 *   1. 原生 fetch + AbortController 超时（10 s），零新增依赖。
 *   2. 失败静默降级：未配置、超时、4xx/5xx、非预期 JSON —— 一律返回
 *      { ok:false, code, message }，**绝不把原始响应体抛到界面**
 *      （上游错误文本只进服务端日志，且日志中不含密钥）。
 *   3. 密钥只从入参传入（来自 ai-config 的 getConfig），本模块不读库。
 *
 * 关于提供方：除豆包（doubao）方舟外，全部尝试一次 /models；豆包的 /models
 * 语义是接入点而非模型，直接返回 UNSUPPORTED_PROVIDER，由设置页提前提示手填
 * 接入点 ID。custom 等未知网关也可能不支持，失败即按状态码归为 AUTH_FAILED /
 * UPSTREAM_ERROR，不在此硬编码白名单。
 *
 * Abhängigkeiten: server/logger.js（无传递依赖）
 */

import { createLogger } from '../logger.js';

const log = createLogger('AIModels');

/** /models 拉取超时（毫秒）。清单不大，10 s 足够。 */
export const MODELS_TIMEOUT_MS = 10000;

/**
 * 拉取提供方的模型清单（OpenAI 兼容 GET {baseUrl}/models）。
 *
 * 校验顺序（与 ai-recipe 的 resolveTarget 一致，但针对「列清单」场景）：
 *   1. 豆包（doubao）→ UNSUPPORTED_PROVIDER（不发请求）。
 *   2. 无 API Key    → NO_KEY。
 *   3. 无可用 Base URL（用户留空且预设也没有）→ NO_CONFIG。
 *   4. 其余提供方尝试请求 → 200 解析、401/403 → AUTH_FAILED、其他/异常 →
 *      UPSTREAM_ERROR。
 *
 * @param {{provider?: string, baseUrl?: string, apiKey?: string}} cfg
 * @returns {Promise<{ok: boolean, models?: string[], provider?: string,
 *                    code?: string, message?: string, status?: number,
 *                    latencyMs?: number}>}
 */
export async function listProviderModels(cfg = {}) {
  const provider = String(cfg.provider ?? '').trim() || 'custom';
  const apiKey = cfg.apiKey || null;
  const baseUrl = String(cfg.baseUrl ?? '').trim();

  // 1. 豆包方舟：/models 返回的是接入点而非模型，语义不同 —— 直接拒绝，不请求。
  if (provider === 'doubao') {
    return {
      ok: false,
      code: 'UNSUPPORTED_PROVIDER',
      message: 'Volcano Ark (Doubao) uses endpoint IDs, not model names.',
    };
  }

  // 2. 必须有密钥（拉清单用的是刚存进库的 key）。
  if (!apiKey) {
    return { ok: false, code: 'NO_KEY', message: 'No API key is configured.' };
  }

  // 3. 必须有可用的 Base URL（配置 baseUrl 优先，否则提供方预设；都为空则无端点）。
  if (!baseUrl) {
    return { ok: false, code: 'NO_CONFIG', message: 'No endpoint URL is configured.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    // 401/403：密钥被拒，明确区分，便于用户定位（不回传上游响应体）。
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        code: 'AUTH_FAILED',
        message: 'The provider rejected the API key.',
        status: response.status,
        latencyMs: Date.now() - startedAt,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        code: 'UPSTREAM_ERROR',
        message: 'The provider returned an error.',
        status: response.status,
        latencyMs: Date.now() - startedAt,
      };
    }

    const payload = await response.json().catch(() => null);
    const data = payload?.data;
    if (!Array.isArray(data)) {
      // 上游形状异常：只记状态码，不把响应体原文写进日志或响应。
      log.warn('AI /models response missing data array', response.status);
      return {
        ok: false,
        code: 'UPSTREAM_ERROR',
        message: 'The provider returned an unexpected response shape.',
        latencyMs: Date.now() - startedAt,
      };
    }

    // 提取每个条目的 id，过滤非法项，按字符串升序排序（稳定、可预期）。
    const models = data
      .map((entry) => (entry && typeof entry.id === 'string' ? entry.id : null))
      .filter((id) => id && id.length > 0)
      .sort((a, b) => a.localeCompare(b));

    return {
      ok: true,
      models,
      provider,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || String(err?.message ?? '').includes('aborted');
    // 日志只记「超时 / 网络错误」这一层事实，绝不包含密钥或上游响应体原文。
    log.warn('AI /models request failed:', aborted ? 'timeout' : 'network error');
    return {
      ok: false,
      code: 'UPSTREAM_ERROR',
      message: aborted
        ? 'The provider did not answer in time.'
        : 'The provider could not be reached.',
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
