/**
 * Modul: AI 提供方配置（ai_config）
 * Zweck: 设置页「AI」区块的读写服务 —— Base URL / 模型名进数据库，
 *        API Key **必须以 SM4 密文落库**（与 SMTP 密码、联系人电话同一套约定，
 *        见 server/services/sm4.js）。
 *
 * 安全约定：
 *   - 对外（HTTP 响应）永远不返回明文 Key，只给 `keySet` 与掩码后的后四位。
 *   - 环境变量 JUJU_SM4_KEY 缺失时 encryptField 会抛错；这里转成可读错误码，
 *     由路由给出友好提示，不把异常文本抛到界面。
 *   - 全站只有一行配置（id = 1，CHECK 约束），多租户不是这个应用的场景。
 *
 * Abhängigkeiten: server/db.js, server/services/sm4.js
 */

import * as db from '../db.js';
import { encryptField, decryptField } from './sm4.js';
import { createLogger } from '../logger.js';

const log = createLogger('AIConfig');

/**
 * 预设提供方。全部走 OpenAI 兼容的 /chat/completions，
 * 换成别的协议不是这个版本的事（扩展时在 blossom 处加 SDK 即可）。
 *
 * R1 (v0.0.33)：4 → 11 项（国内主流 + OpenAI + 自定义）。新增可选字段
 * （既有条目形状兼容，旧数据不失效）：
 *   keyUrl       密钥申请地址（设置页渲染「申请密钥」外链；缺省不显示）
 *   hintKey      i18n-Key 后缀 → t(`ai.providerHint.${hintKey}`)，缺省用
 *                通用 ai.baseUrlHint
 *   modelHintKey 模型输入框专属提示后缀 → t(`ai.modelHints.${modelHintKey}`)，
 *                缺省用 ai.modelHint（豆包方舟要接入点 ID，不是模型名。
 *                注意： NICHT t(`ai.modelHint.${...}`) - ai.modelHint 是既有
 *                字符串键，Dot-Resolver 无法在其下挂嵌套键）
 *
 * custom 必须保持末位：providerByKey() 对未知 key 回落最后一项。
 */
export const AI_PROVIDERS = Object.freeze([
  {
    key: 'openai', label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    keyUrl: 'https://platform.openai.com',
  },
  {
    key: 'deepseek', label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com',
  },
  {
    key: 'qwen', label: '通义千问（阿里百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long'],
    keyUrl: 'https://bailian.console.aliyun.com',
  },
  {
    key: 'zhipu', label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air'],
    keyUrl: 'https://open.bigmodel.cn',
  },
  {
    key: 'moonshot', label: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyUrl: 'https://platform.moonshot.cn',
  },
  {
    key: 'doubao', label: '豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [],
    keyUrl: 'https://console.volcengine.com/ark',
    hintKey: 'doubao', modelHintKey: 'doubao',
  },
  {
    key: 'minimax', label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-M2', 'abab7-chat'],
    keyUrl: 'https://www.minimaxi.com',
  },
  {
    key: 'qianfan', label: '百度千帆（文心）',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    models: ['ernie-4.5-turbo', 'ernie-speed', 'ernie-lite'],
    keyUrl: 'https://qianfan.baidubce.com',
    hintKey: 'qianfan',
  },
  {
    key: 'hunyuan', label: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-turbos', 'hunyuan-t1'],
    keyUrl: 'https://console.cloud.tencent.com/hunyuan',
  },
  {
    key: 'siliconflow', label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen3-8B', 'deepseek-ai/DeepSeek-V3.2', 'THUDM/GLM-4.6'],
    keyUrl: 'https://siliconflow.cn',
    hintKey: 'siliconflow',
  },
  {
    key: 'custom', label: '自定义（OpenAI 兼容）',
    baseUrl: '', models: [],
    hintKey: 'custom',
  },
]);

/** 提供方 key → 定义；未知一律按 custom 处理（不拒绝，用户可能有私有网关）。 */
export function providerByKey(key) {
  return AI_PROVIDERS.find((p) => p.key === String(key ?? '').trim()) ?? AI_PROVIDERS[AI_PROVIDERS.length - 1];
}

/** 缺省公开视图：没配过任何东西时界面也有一份稳定的形状。 */
const EMPTY_PUBLIC = Object.freeze({
  provider: 'openai',
  baseUrl: '',
  effectiveBaseUrl: '',
  model: '',
  enabled: false,
  keySet: false,
  maskedKey: '',
  updatedAt: null,
  updatedByName: null,
});

/**
 * 保证 id=1 的配置行存在（首次使用自动建一条空配置）。
 * @returns {void}
 */
function ensureRow() {
  db.get().prepare('INSERT OR IGNORE INTO ai_config (id, provider, enabled) VALUES (1, ?, 0)')
    .run(AI_PROVIDERS[0].key);
}

/**
 * 读配置（含解密后的明文 Key）——**仅服务端内部调用**，不要进 HTTP 响应。
 * @returns {{provider: string, baseUrl: string|null, apiKey: string|null, model: string|null,
 *            enabled: boolean, updatedAt: string|null, updatedBy: number|null}}
 */
export function getConfig() {
  try {
    ensureRow();
    const row = db.get().prepare('SELECT * FROM ai_config WHERE id = 1').get();
    if (!row) return { provider: 'openai', baseUrl: null, apiKey: null, model: null, enabled: false, updatedAt: null, updatedBy: null };
    return {
      provider: row.provider || 'custom',
      baseUrl: row.base_url || null,
      apiKey: decryptField(row.api_key) || null,
      model: row.model || null,
      enabled: Number(row.enabled) === 1,
      updatedAt: row.updated_at || null,
      updatedBy: row.updated_by ?? null,
    };
  } catch (err) {
    log.error('Reading AI config failed:', err?.message || err);
    return { provider: 'openai', baseUrl: null, apiKey: null, model: null, enabled: false, updatedAt: null, updatedBy: null };
  }
}

/** Key 掩码：只看得见后四位，其余用圆点代替。 */
export function maskKey(plain) {
  const text = String(plain ?? '');
  if (!text) return '';
  if (text.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(12, Math.max(4, text.length - 4)))}${text.slice(-4)}`;
}

/**
 * 对外的安全视图（设置页用）。
 * @returns {{provider: string, baseUrl: string, effectiveBaseUrl: string, model: string,
 *            enabled: boolean, keySet: boolean, maskedKey: string, updatedAt: string|null,
 *            updatedByName: string|null, providers: typeof AI_PROVIDERS}}
 */
export function getPublicConfig() {
  const cfg = getConfig();
  const provider = providerByKey(cfg.provider);
  return {
    provider: provider.key,
    baseUrl: cfg.baseUrl || '',
    // 用户留空 Base URL 时（常见于只选了预设提供方）实际请求打去哪里。
    effectiveBaseUrl: cfg.baseUrl || provider.baseUrl || '',
    model: cfg.model || '',
    enabled: cfg.enabled,
    keySet: Boolean(cfg.apiKey),
    maskedKey: maskKey(cfg.apiKey),
    updatedAt: cfg.updatedAt,
    updatedByName: db.get()
      .prepare('SELECT display_name FROM users WHERE id = ?')
      .get(cfg.updatedBy)?.display_name ?? null,
    providers: AI_PROVIDERS,
  };
}

/**
 * Base URL 归一化：去尾斜杠、只接受 http(s)。
 * 非法值返回空串（表示「未自填，走提供方预设」）而不是报错：少一次打断。
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeBaseUrl(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text) return '';
  return /^https?:\/\/\S+/i.test(text) ? text : '';
}

/**
 * 保存配置。
 * Key 的三态约定（与 SMTP 密码一致）：
 *   - 给了非空 apiKey → 覆盖
 *   - clearKey === true → 清空
 *   - 都没给 → 保持原值不动（用户在网页上看到掩码但不想改）
 *
 * @param {{provider?: string, baseUrl?: string, apiKey?: string, model?: string,
 *          enabled?: boolean, clearKey?: boolean}} patch
 * @param {number|null} userId
 * @returns {{ok: boolean, data?: object, error?: string, code?: string}}
 */
export function saveConfig(patch = {}, userId = null) {
  try {
    ensureRow();
    const current = getConfig();

    // provider 与其余字段同一套三态规则：没传就保留原值，传了对未知值降级
    // 为 custom（私有网关常见），而不是静默改写成 custom。
    const provider = patch.provider === undefined
      ? (current.provider || AI_PROVIDERS[0].key)
      : providerByKey(patch.provider).key;
    const baseUrl = patch.baseUrl === undefined
      ? (current.baseUrl || '')
      : sanitizeBaseUrl(patch.baseUrl);
    const model = patch.model === undefined
      ? (current.model || '')
      : String(patch.model ?? '').trim().slice(0, 120);
    const enabled = patch.enabled === undefined
      ? current.enabled
      : Boolean(patch.enabled);

    let apiKey = current.apiKey;
    if (patch.clearKey === true) {
      apiKey = null;
    } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') {
      apiKey = patch.apiKey.trim();
    }

    let storedKey;
    try {
      storedKey = apiKey ? encryptField(apiKey) : null;
    } catch (err) {
      log.error('Encrypting AI API key failed:', err?.message || err);
      return { ok: false, error: 'The API key could not be saved securely.', code: 'ENCRYPTION_UNAVAILABLE' };
    }

    db.get().prepare(`
      UPDATE ai_config
      SET provider = ?, base_url = ?, api_key = ?, model = ?, enabled = ?,
          updated_by = ?, updated_at = ?
      WHERE id = 1
    `).run(
      provider,
      baseUrl || null,
      storedKey,
      model || null,
      enabled ? 1 : 0,
      userId,
      new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );

    return { ok: true, data: getPublicConfig() };
  } catch (err) {
    log.error('Saving AI config failed:', err?.message || err);
    return { ok: false, error: 'The AI settings could not be saved.', code: 'SAVE_FAILED' };
  }
}
