/**
 * Modul: KI-Fehlercodes → i18n-Key
 * Zweck: server/services/ai-recipe.js 返回的错误码是稳定枚举值；两处界面
 *        （设置页 > AI、菜谱页 > AI 生成）都要把它们翻译成一句人话。
 *
 * 为什么要单独一个文件：同一个映射写两遍，迟早只有一边被改到，届时同一个
 * 故障在设置页说得清、在菜谱页说不清。这里的键名也是 i18n 契约的一部分。
 *
 * 未列出的码一律落到 ai.errorUnexpected —— 宁可含糊，也不要把上游原始错误
 * 文本甩到界面上（见 services/ai-recipe.js 的日志约定）。
 */

/** 错误码 → i18n key。 */
const ERROR_KEYS = new Map([
  ['no_config', 'ai.errorNoConfig'],
  ['disabled', 'ai.errorDisabled'],
  ['no_key', 'ai.errorNoKey'],
  ['no_model', 'ai.errorNoModel'],
  ['timeout', 'ai.errorTimeout'],
  ['http', 'ai.errorHttp'],
  ['auth', 'ai.errorAuth'],
  ['network', 'ai.errorNetwork'],
  ['empty_prompt', 'ai.errorEmptyPrompt'],
  ['prompt_too_long', 'ai.errorPromptTooLong'],
  ['empty_response', 'ai.errorEmptyResponse'],
  ['unexpected', 'ai.errorUnexpected'],
  // 模型清单动态拉取（GET /api/v1/ai/models）。NO_KEY / NO_CONFIG / AUTH_FAILED
  // 复用既有的文案 key；UPSTREAM_ERROR / UNSUPPORTED_PROVIDER 为本次新增。
  ['NO_CONFIG', 'ai.errorNoConfig'],
  ['NO_KEY', 'ai.errorNoKey'],
  ['AUTH_FAILED', 'ai.errorAuth'],
  ['UPSTREAM_ERROR', 'ai.errorUpstream'],
  ['UNSUPPORTED_PROVIDER', 'ai.errorUnsupportedProvider'],
]);

/**
 * @param {string|null|undefined} code 服务端返回的错误码
 * @returns {string} i18n key（必定有值）
 */
export function aiErrorKey(code) {
  return ERROR_KEYS.get(String(code ?? '').trim()) ?? 'ai.errorUnexpected';
}
