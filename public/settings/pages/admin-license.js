/**
 * Modul: Settings – Lizenz (License activation)
 * Zweck: 授权状态展示 + License Key 激活。
 *        - 社区版（未启用强制授权，JUJU_LICENSE_MASTER 未设置）：仅说明，无需操作。
 *        - 强制版：输入由提供方签发的 Key（JUJU1-...）激活本实例。
 *
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

export async function render(container) {
  let st = { mode: 'community', licensed: true, enforcementEnabled: false };
  try {
    const res = await api.get('/license/status');
    st = res?.data ?? st;
  } catch (_) {
    // Konnte nicht geladen werden -> community als Fallback.
  }

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="settings-card">
        <div id="lic-notice" role="status"></div>
        <div id="lic-status"></div>
        <div id="lic-activate" ${st.enforcementEnabled ? '' : 'hidden'} class="form-group" style="margin-top:14px">
          <label class="label" for="lic-key">${esc(t('license.keyLabel'))}</label>
          <textarea class="input" id="lic-key" rows="3" placeholder="${esc(t('license.keyPlaceholder'))}"></textarea>
          <div class="form-actions">
            <button type="button" class="btn btn--primary" id="lic-activate-btn">${esc(t('license.activate'))}</button>
          </div>
          <p class="form-hint">${esc(t('license.activateHint'))}</p>
        </div>
      </div>
    </section>
  `);

  renderStatus(container, st);

  const btn = container.querySelector('#lic-activate-btn');
  btn?.addEventListener('click', async () => {
    const key = container.querySelector('#lic-key').value.trim();
    if (!key) { showNotice(container, t('license.empty'), 'danger'); return; }
    btn.disabled = true;
    try {
      const res = await api.post('/license/activate', { key });
      if (res?.data?.ok) {
        showNotice(container, t('license.activated'), 'success');
        const r = await api.get('/license/status');
        renderStatus(container, r?.data ?? st);
      } else {
        showNotice(container, res?.data?.error || t('license.fail'), 'danger');
      }
    } catch (err) {
      showNotice(container, err?.data?.error || t('license.fail'), 'danger');
    } finally {
      btn.disabled = false;
    }
  });
}

function renderStatus(container, st) {
  const el = container.querySelector('#lic-status');
  if (!el) return;
  if (!st.enforcementEnabled) {
    el.innerHTML = `<p class="form-hint">${esc(t('license.community'))}</p>`;
    return;
  }
  if (st.licensed) {
    const p = st.payload || {};
    el.innerHTML = `
      <p class="form-hint lic-ok">${esc(t('license.active'))}</p>
      <ul class="lic-meta">
        <li><span>${esc(t('license.subject'))}：</span>${esc(p.sub || '-')}</li>
        <li><span>${esc(t('license.devices'))}：</span>${esc(String(p.dev ?? '-'))}</li>
        <li><span>${esc(t('license.expires'))}：</span>${esc(p.exp ? new Date(p.exp).toLocaleDateString() : t('license.never'))}</li>
        <li><span>${esc(t('license.activatedAt'))}：</span>${esc(st.activatedAt ? new Date(st.activatedAt).toLocaleString() : '-')}</li>
      </ul>`;
  } else {
    el.innerHTML = `<p class="form-hint lic-warn">${esc(st.reason === 'expired' ? t('license.expiredMsg') : t('license.notActivated'))}</p>`;
  }
}

function showNotice(container, msg, kind) {
  const el = container.querySelector('#lic-notice');
  if (!el) return;
  el.className = `form-notice form-notice--${kind}`;
  el.textContent = msg;
}
