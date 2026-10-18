/**
 * Modul: 2FA-Karte (Einstellungen → Sicherheit)
 * Zweck: Selbstbedienung für TOTP-Zwei-Faktor-Authentifizierung.
 *
 * Zustandsautomat — bewusst klein gehalten, aber mit einer wichtigen Regel:
 * 2FA wird erst scharfgeschaltet, wenn ein Code aus der App die Einrichtung
 * bestätigt hat. Wer den QR-Code nicht scannen kann und abbricht, bleibt also
 * nicht mit einem halb eingerichteten Konto sitzen.
 *
 *   aus ──(Passwort)──▶ setup ──(Code)──▶ an ──(Code + Passwort)──▶ aus
 *                          │                │
 *                          │                └── Codes erneuern (nur Code)
 *                          └── zeigt QR + Secret, danach 8 Wiederherstellungscodes
 *
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */

import { auth } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

/** @type {{ loading: boolean, loadError: string|null, enabled: boolean, remaining: number, setup: object|null, codes: string[]|null, error: string|null, busy: boolean }} */
const state = {
  loading: true,
  loadError: null,
  enabled: false,
  remaining: 0,
  setup: null,
  codes: null,
  error: null,
  busy: false,
};

/**
 * Übersetzt die maschinenlesbare `reason` der API in einen Satz.
 * @param {any} err
 * @returns {string}
 */
function message(err) {
  switch (err?.data?.reason) {
    case 'invalid_code':      return t('settings.twoFactorErrorInvalidCode');
    case 'invalid_password':  return t('settings.twoFactorErrorPassword');
    case 'password_required': return t('settings.twoFactorErrorPasswordRequired');
    case 'rate_limited':      return t('settings.twoFactorErrorRateLimited');
    case 'already_enabled':   return t('settings.twoFactorErrorAlreadyEnabled');
    case 'not_enabled':       return t('settings.twoFactorErrorNotEnabled');
    case 'setup_required':    return t('settings.twoFactorErrorSetupRequired');
    default:                  return err?.message || t('common.errorGeneric');
  }
}

function setError(text) {
  state.error = text;
  state.busy = false;
  render();
}

function clearError() {
  state.error = null;
}

let host = null;

// --------------------------------------------------------
// Rendering
// --------------------------------------------------------

function errorBlock() {
  return `<div id="twofa-error" class="form-error" role="alert"${state.error ? '' : ' hidden'}>${esc(state.error || '')}</div>`;
}

function template() {
  if (state.loading) {
    return `<p class="form-hint">${t('common.loading')}</p>`;
  }

  if (state.loadError) {
    return `
      <p class="form-error" role="alert">${esc(state.loadError)}</p>
      <div class="settings-form-actions">
        <button type="button" class="btn btn--secondary" id="twofa-reload">${t('settings.retry')}</button>
      </div>`;
  }

  // ③ Frische Wiederherstellungscodes: genau einmal sichtbar, dann nie wieder.
  if (state.codes) {
    return `
      <div class="settings-banner settings-banner--info" role="status">${t('settings.twoFactorRecoveryOnce')}</div>
      <ul class="settings-recovery-list">
        ${state.codes.map((code) => `<li><code>${esc(code)}</code></li>`).join('')}
      </ul>
      <div class="settings-form-actions">
        <button type="button" class="btn btn--secondary" id="twofa-codes-copy">${t('settings.twoFactorCopyCodes')}</button>
        <button type="button" class="btn btn--primary" id="twofa-codes-done">${t('settings.twoFactorCodesDone')}</button>
      </div>`;
  }

  // ② Einrichtung: QR-Code, Secret zum Eintippen, Bestätigungscode.
  if (state.setup) {
    return `
      <div class="settings-twofa-setup">
        <div class="settings-twofa-qr">${state.setup.qr_svg}</div>
        <div class="settings-twofa-manual">
          <p class="form-hint">${t('settings.twoFactorScanHint')}</p>
          <p class="form-hint">${t('settings.twoFactorManualHint')}</p>
          <p class="settings-twofa-secret"><code id="twofa-secret">${esc(state.setup.secret)}</code></p>
          <details class="settings-twofa-details">
            <summary>${t('settings.twoFactorShowUri')}</summary>
            <code class="settings-twofa-uri">${esc(state.setup.otpauth_uri)}</code>
          </details>
        </div>
      </div>
      <form id="twofa-enable-form" class="settings-form">
        <div class="form-group">
          <label class="form-label" for="twofa-enable-code">${t('settings.twoFactorCodeLabel')}</label>
          <input class="form-input" type="text" id="twofa-enable-code" inputmode="numeric"
                 autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" placeholder="000000"
                 aria-describedby="twofa-error" required>
          <p class="form-hint">${t('settings.twoFactorCodeHint')}</p>
        </div>
        ${errorBlock()}
        <div class="settings-form-actions">
          <button type="button" class="btn btn--secondary" id="twofa-cancel">${t('common.cancel')}</button>
          <button type="submit" class="btn btn--primary"${state.busy ? ' disabled' : ''}>${t('settings.twoFactorSubmit')}</button>
        </div>
      </form>`;
  }

  // ④ Aktiv: Status, Rest-Codes, Codes erneuern / 2FA abschalten.
  if (state.enabled) {
    return `
      <p class="settings-twofa-state settings-twofa-state--on">
        <i data-lucide="shield-check" aria-hidden="true"></i> ${t('settings.twoFactorEnabled')}
      </p>
      <p class="form-hint">${t('settings.twoFactorRecoveryRemaining', { count: state.remaining })}</p>
      <form id="twofa-manage-form" class="settings-form">
        <div class="form-group">
          <label class="form-label" for="twofa-action-code">${t('settings.twoFactorCodeLabel')}</label>
          <input class="form-input" type="text" id="twofa-action-code" inputmode="numeric"
                 autocomplete="one-time-code" maxlength="16" aria-describedby="twofa-error" required>
          <p class="form-hint">${t('settings.twoFactorManageHint')}</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="twofa-action-password">${t('settings.twoFactorDisablePasswordLabel')}</label>
          <input class="form-input" type="password" id="twofa-action-password" autocomplete="current-password"
                 aria-describedby="twofa-error">
          <p class="form-hint">${t('settings.twoFactorDisablePasswordHint')}</p>
        </div>
        ${errorBlock()}
        <div class="settings-form-actions">
          <button type="button" class="btn btn--secondary" id="twofa-regen">${t('settings.twoFactorRegenerate')}</button>
          <button type="button" class="btn btn--danger-outline" id="twofa-disable">${t('settings.twoFactorDisableButton')}</button>
        </div>
      </form>`;
  }

  // ① Aus: der Start verlangt das eigene Passwort.
  return `
    <p class="settings-twofa-state">
      <i data-lucide="shield-off" aria-hidden="true"></i> ${t('settings.twoFactorDisabled')}
    </p>
    <form id="twofa-start-form" class="settings-form">
      <div class="form-group">
        <label class="form-label" for="twofa-password">${t('settings.currentPasswordLabel')}</label>
        <input class="form-input" type="password" id="twofa-password" autocomplete="current-password"
               aria-describedby="twofa-error" required>
        <p class="form-hint">${t('settings.twoFactorStartHint')}</p>
      </div>
      ${errorBlock()}
      <div class="settings-form-actions">
        <button type="submit" class="btn btn--primary"${state.busy ? ' disabled' : ''}>${t('settings.twoFactorStartButton')}</button>
      </div>
    </form>`;
}

function render() {
  if (!host) return;
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', template());
  window.lucide?.createIcons({ el: host });
  bind();
}

// --------------------------------------------------------
// Aktionen
// --------------------------------------------------------

async function load() {
  state.loading = true;
  state.loadError = null;
  render();
  try {
    const res = await auth.twoFactorStatus();
    const data = res?.data ?? {};
    state.enabled = Boolean(data.enabled);
    state.remaining = Number(data.recovery_codes_remaining) || 0;
  } catch (err) {
    state.loadError = message(err);
  } finally {
    state.loading = false;
    render();
  }
}

function bind() {
  if (!host) return;

  host.querySelector('#twofa-reload')?.addEventListener('click', load);

  // ① Einrichtung starten
  host.querySelector('#twofa-start-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    const input = host.querySelector('#twofa-password');
    state.busy = true;
    render();
    try {
      const res = await auth.twoFactorSetup(input?.value || '');
      state.setup = res?.data ?? null;
      if (!state.setup) return setError(t('common.errorGeneric'));
      if (input) input.value = '';
    } catch (err) {
      return setError(message(err));
    }
    state.busy = false;
    render();
  });

  // ② Abbrechen — das angelegte Secret bleibt harmlos, solange 2FA aus ist.
  host.querySelector('#twofa-cancel')?.addEventListener('click', () => {
    state.setup = null;
    clearError();
    render();
  });

  // ② Bestätigen und 2FA scharfschalten
  host.querySelector('#twofa-enable-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    const input = host.querySelector('#twofa-enable-code');
    state.busy = true;
    render();
    try {
      const res = await auth.twoFactorEnable((input?.value || '').trim());
      state.codes = res?.data?.recovery_codes ?? null;
      state.setup = null;
      state.enabled = true;
      state.remaining = state.codes ? state.codes.length : state.remaining;
      window.yuvomi?.showToast(t('settings.twoFactorEnabledToast'), 'success');
    } catch (err) {
      return setError(message(err));
    }
    state.busy = false;
    render();
  });

  // ③ Codes kopieren / quittieren
  host.querySelector('#twofa-codes-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText((state.codes || []).join('\n'));
      window.yuvomi?.showToast(t('settings.twoFactorCopiedToast'), 'success');
    } catch {
      window.yuvomi?.showToast(t('settings.twoFactorCopyFailed'), 'danger');
    }
  });

  host.querySelector('#twofa-codes-done')?.addEventListener('click', () => {
    // Bewusst: ab hier sind die Codes nicht mehr abrufbar.
    state.codes = null;
    render();
  });

  // ④ Codes erneuern
  host.querySelector('#twofa-regen')?.addEventListener('click', async () => {
    clearError();
    const input = host.querySelector('#twofa-action-code');
    state.busy = true;
    render();
    try {
      const res = await auth.twoFactorRegenerateCodes((input?.value || '').trim());
      state.codes = res?.data?.recovery_codes ?? null;
      state.remaining = state.codes ? state.codes.length : state.remaining;
      if (input) input.value = '';
    } catch (err) {
      return setError(message(err));
    }
    state.busy = false;
    render();
  });

  // ④ Abschalten: Code UND Passwort, damit ein offener Tab nicht genügt.
  host.querySelector('#twofa-disable')?.addEventListener('click', async () => {
    clearError();
    const codeInput = host.querySelector('#twofa-action-code');
    const passwordInput = host.querySelector('#twofa-action-password');
    const code = (codeInput?.value || '').trim();
    const password = passwordInput?.value || '';
    if (!code) return setError(t('settings.twoFactorErrorInvalidCode'));
    if (!password) return setError(t('settings.twoFactorErrorPasswordRequired'));

    state.busy = true;
    render();
    try {
      await auth.twoFactorDisable(password, code);
      state.enabled = false;
      state.remaining = 0;
      window.yuvomi?.showToast(t('settings.twoFactorDisabledToast'), 'success');
    } catch (err) {
      return setError(message(err));
    }
    state.busy = false;
    render();
  });
}

/**
 * Baut die 2FA-Karte in den gegebenen Container und lädt ihren Status.
 * @param {HTMLElement} container
 */
export async function mountTwoFactor(container) {
  host = container;
  await load();
}
