/**
 * Modul: Settings – KI (Rezeptgenerierung)
 * Zweck: 家庭自建 AI 入口的配置页 —— 提供方、Base URL、密钥(SM4 加密落库)、
 *        模型名、总开关。
 *
 * 原则：
 *   - 密钥只出不进：保存后可以清空重设，但界面永远拿不到旧明文（后端只返回
 *     掩码与 keySet 标志）。
 *   - 连接测试的错误按 code 映射成一句人话，绝不显示上游响应体。
 *   - 全部字段允许留空保存 —— 没配完就关着开关，不必先配完才能关。
 *
 * Abhängigkeiten: /api.js (aiRecipe), /i18n.js, /utils/html.js,
 *                 /settings/components.js
 */

import { aiRecipe } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { createInlineError, createToggleRow } from '/settings/components.js';
import { aiErrorKey } from '/utils/ai-errors.js';

const DEFAULTS = {
  provider: 'openai',
  baseUrl: '',
  effectiveBaseUrl: '',
  model: '',
  enabled: false,
  keySet: false,
  maskedKey: '',
  providers: [],
};

/** 错误码 → i18n key（映射集中在 /utils/ai-errors.js：设置页与菜谱页同一说法）。 */
const mapErrorKey = aiErrorKey;

export async function render(container) {
  let cfg = { ...DEFAULTS };
  try {
    const res = await aiRecipe.getConfig();
    cfg = { ...DEFAULTS, ...(res?.data ?? {}) };
  } catch (_) {
    // Konnte nicht geladen werden -> leeres Formular, kein Hindernis.
  }

  const providers = cfg.providers.length > 0
    ? cfg.providers
    : [{ key: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: [] }];

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="settings-card">
        <p class="form-hint">${esc(t('ai.purposeHint'))}</p>
        <div id="ai-notice" role="status"></div>
        <form class="settings-form" id="ai-form" novalidate>
          <div class="form-group">
            <label class="label" for="ai-enabled">${esc(t('ai.enabled'))}</label>
            <div id="ai-enabled-slot"></div>
            <p class="form-hint">${esc(t('ai.enabledHint'))}</p>
          </div>
          <div class="form-group">
            <label class="label" for="ai-provider">${esc(t('ai.provider'))}</label>
            <select class="input" id="ai-provider" name="provider">
              ${providers.map((p) => `<option value="${esc(p.key)}"${p.key === cfg.provider ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
            </select>
            <p class="form-hint" id="ai-provider-hint"></p>
          </div>
          <div class="form-group">
            <label class="label" for="ai-base-url">${esc(t('ai.baseUrl'))}</label>
            <input class="input" id="ai-base-url" name="baseUrl" value="${esc(cfg.baseUrl)}" autocomplete="off"
              placeholder="${esc(providers.find((p) => p.key === cfg.provider)?.baseUrl || 'https://api.openai.com/v1')}" />
            <p class="form-hint">${esc(t('ai.baseUrlHint'))}</p>
          </div>
          <div class="form-group">
            <label class="label" for="ai-model">${esc(t('ai.model'))}</label>
            <input class="input" id="ai-model" name="model" value="${esc(cfg.model)}" list="ai-model-options" autocomplete="off" />
            <datalist id="ai-model-options">
              ${(providers.find((p) => p.key === cfg.provider)?.models ?? []).map((m) => `<option value="${esc(m)}"></option>`).join('')}
            </datalist>
            <p class="form-hint" id="ai-model-hint">${esc(t('ai.modelHint'))}</p>
          </div>
          <div class="form-group">
            <label class="label" for="ai-key">${esc(t('ai.apiKey'))}</label>
            <input class="input" id="ai-key" name="apiKey" type="password" autocomplete="new-password"
              placeholder="${esc(cfg.keySet ? cfg.maskedKey : '')}" />
            <p class="form-hint">${esc(cfg.keySet ? t('ai.apiKeyKeep') : t('ai.apiKeyHint'))}</p>
            <p class="form-hint" id="ai-key-link"></p>
          </div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary" id="ai-save">${esc(t('common.save'))}</button>
            <button type="button" class="btn btn--secondary" id="ai-test">${esc(t('ai.test'))}</button>
            <button type="button" class="btn btn--ghost" id="ai-clear-key">${esc(t('ai.clearKey'))}</button>
          </div>
        </form>
      </div>
    </section>
  `);

  const form = container.querySelector('#ai-form');
  const notice = container.querySelector('#ai-notice');
  const providerHint = container.querySelector('#ai-provider-hint');
  const modelHint = container.querySelector('#ai-model-hint');
  const keyLink = container.querySelector('#ai-key-link');
  const baseUrlInput = container.querySelector('#ai-base-url');
  const modelInput = container.querySelector('#ai-model');
  const modelOptions = container.querySelector('#ai-model-options');
  const saveBtn = container.querySelector('#ai-save');
  const testBtn = container.querySelector('#ai-test');
  const clearKeyBtn = container.querySelector('#ai-clear-key');

  const showError = (msg) => notice.replaceChildren(createInlineError(msg));
  const clearNotice = () => notice.replaceChildren();
  const showToast = (msg) => {
    clearNotice();
    window.yuvomi?.showToast(msg, 'success');
  };

  // Gesamtschalter: wie in anderen Blättern ein echtes Toggle (createToggleRow),
  // kein zweiter Submit-Button mit versteckter Semantik.
  const toggleSlot = container.querySelector('#ai-enabled-slot');
  let enabled = Boolean(cfg.enabled);
  const toggle = createToggleRow({ label: t('ai.enabledLabel'), checked: enabled });
  const toggleInput = toggle.querySelector('input[type="checkbox"]');
  // createToggleRow liefert nur Markup zurück; der Listener gehört wie überall
  // in den Settings zur aufrufenden Seite (vgl. sync-calendar.js).
  if (toggleInput) toggleInput.addEventListener('change', () => { enabled = toggleInput.checked; });
  toggleSlot.appendChild(toggle);

  /**
   * R1 (v0.0.33): provider-spezifische Hinweise. Der Server liefert je
   * Preset optional `hintKey` / `modelHintKey` / `keyUrl` mit; fehlt ein
   * Feld, greifen die generischen Texte (ai.baseUrlHint / ai.modelHint).
   *
   * Hinweis zur Key-Wahl: `ai.modelHint` ist ein bestehender String (der
   * generische Text) - die Dot-Notation von t() kann darunter kein
   * `ai.modelHint.doubao` ablegen, ohne den String zu ersetzen. Die
   * modellspezifischen Texte leben deshalb im Geschwister-Objekt
   * `ai.modelHints.<modelHintKey>` (analog zum reinen Objekt
   * `ai.providerHint`, das keinen String-Vorfahren hat).
   * @param {object} provider  Eintrag aus AI_PROVIDERS
   */
  function applyProviderHints(provider) {
    providerHint.textContent = provider.hintKey
      ? t(`ai.providerHint.${provider.hintKey}`)
      : t('ai.baseUrlHint');
    modelHint.textContent = provider.modelHintKey
      ? t(`ai.modelHints.${provider.modelHintKey}`)
      : t('ai.modelHint');
    if (provider.keyUrl) {
      keyLink.replaceChildren();
      const link = document.createElement('a');
      link.href = provider.keyUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = t('ai.getApiKey');
      keyLink.appendChild(link);
    } else {
      keyLink.replaceChildren();
    }
  }

  /** 切换提供方时同步「预设 Base URL / 模型建议」，用户填过的不覆盖。 */
  form.provider.addEventListener('change', () => {
    const provider = providers.find((p) => p.key === form.provider.value) ?? providers[0];
    baseUrlInput.placeholder = provider.baseUrl || 'https://api.openai.com/v1';
    applyProviderHints(provider);
    modelOptions.replaceChildren();
    for (const model of provider.models ?? []) {
      const option = document.createElement('option');
      option.value = model;
      modelOptions.appendChild(option);
    }
  });

  // Initialzustand: Hinweise des gespeicherten Providers (nicht nur on change).
  applyProviderHints(providers.find((p) => p.key === cfg.provider) ?? providers[0]);

  /**
   * 组装保存载荷。密钥的「留空 = 保持原值」由后端保证，这里不用传空字符串。
   * @returns {Object}
   */
  function collect() {
    const body = {
      provider: form.provider.value,
      baseUrl: form.baseUrl.value.trim(),
      model: form.model.value.trim(),
      enabled,
    };
    if (form.apiKey.value) body.apiKey = form.apiKey.value;
    return body;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearNotice();
    saveBtn.disabled = true;
    try {
      const res = await aiRecipe.saveConfig(collect());
      const saved = res?.data;
      form.apiKey.value = '';
      if (saved?.maskedKey) form.apiKey.placeholder = saved.maskedKey;
      showToast(t('ai.saved'));
    } catch (error) {
      showError(t('ai.saveFailed', { error: error?.message || t('common.errorGeneric') }));
    } finally {
      saveBtn.disabled = false;
    }
  });

  clearKeyBtn.addEventListener('click', async () => {
    clearKeyBtn.disabled = true;
    try {
      await aiRecipe.saveConfig({ ...collect(), clearKey: true });
      form.apiKey.value = '';
      form.apiKey.placeholder = '';
      showToast(t('ai.keyCleared'));
    } catch (error) {
      showError(t('ai.saveFailed', { error: error?.message || t('common.errorGeneric') }));
    } finally {
      clearKeyBtn.disabled = false;
    }
  });

  testBtn.addEventListener('click', async () => {
    clearNotice();
    testBtn.disabled = true;
    testBtn.textContent = t('ai.testing');
    try {
      // Erst speichern: der Test soll genau das prüfen, was jetzt im Formular
      // steht (dasselbe Muster wie der SMTP-Test unter Admin › E-Mail).
      await aiRecipe.saveConfig(collect());
      form.apiKey.value = '';
      const res = await aiRecipe.test();
      const data = res?.data ?? {};
      if (data.ok) showToast(t('ai.testSuccess', { ms: data.latencyMs ?? 0 }));
      else showError(t(mapErrorKey(data.code)));
    } catch (error) {
      showError(t('ai.testFailed', { error: error?.message || t('common.errorGeneric') }));
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = t('ai.test');
    }
  });
}
