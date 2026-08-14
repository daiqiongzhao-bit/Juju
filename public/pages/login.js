/**
 * Modul: Login-Seite
 * Zweck: Anmeldeformular mit Username/Passwort, Fehlerbehandlung, Session-Start
 * Abhängigkeiten: /api.js
 */

import { auth } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

const VERSION_URL = '/api/v1/version';
const DEFAULT_APP_NAME = 'Juju';
const APP_NAME_STORAGE_KEY = 'yuvomi-app-name';

function getStoredAppName() {
  return localStorage.getItem(APP_NAME_STORAGE_KEY) || DEFAULT_APP_NAME;
}

function setAppBranding(appName) {
  const name = String(appName || '').trim() || DEFAULT_APP_NAME;
  document.title = name;
  const titleEl = document.querySelector('.auth-card__app-name');
  if (titleEl) titleEl.textContent = name;
}

/**
 * Rendert die Login-Seite in den gegebenen Container.
 * @param {HTMLElement} container
 */
export async function render(container) {
  const storedAppName = getStoredAppName();

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <main class="auth-page" id="main-content">
      <div class="auth-wrap">
        <section class="auth-card card card--padded" aria-labelledby="auth-card-title">
          <header class="auth-card__brand">
            <span class="auth-card__mark" aria-hidden="true">
              <svg viewBox="0 0 160 160" fill="none">
                <defs>
                  <linearGradient id="jujuBg" x1="0" y1="0" x2="160" y2="160" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stop-color="#A78BFA"/>
                    <stop offset="46%" stop-color="#8B5CF6"/>
                    <stop offset="100%" stop-color="#6D28D9"/>
                  </linearGradient>
                  <linearGradient id="jujuSheen" x1="0" y1="0" x2="0" y2="160" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stop-color="#ffffff" stop-opacity="0.24"/>
                    <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
                  </linearGradient>
                  <linearGradient id="jujuStroke" x1="44" y1="42" x2="120" y2="126" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stop-color="#ffffff"/>
                    <stop offset="1" stop-color="#F4ECFF"/>
                  </linearGradient>
                </defs>
                <rect x="6" y="6" width="148" height="148" rx="34" fill="url(#jujuBg)"/>
                <rect x="6" y="6" width="148" height="148" rx="34" fill="url(#jujuSheen)"/>
                <rect x="6.5" y="6.5" width="147" height="147" rx="33.5" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1"/>
                <path d="M104 46 L104 100 Q104 122 82 124 Q58 126 50 104" fill="none" stroke="url(#jujuStroke)" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M126 21 C126 27.3 128.7 30 135 30 C128.7 30 126 32.7 126 39 C126 32.7 123.3 30 117 30 C123.3 30 126 27.3 126 21 Z" fill="#ffffff"/>
              </svg>
            </span>
            <div class="auth-card__titles">
              <h1 class="auth-card__app-name" id="auth-card-title">${esc(storedAppName)}</h1>
              <p class="auth-card__tagline">${esc(t('login.tagline'))}</p>
            </div>
          </header>

          <form class="auth-form" id="auth-form" novalidate>
            <div class="form-group">
              <label class="label" for="username">${esc(t('login.usernameLabel'))}</label>
              <input
                class="input"
                type="text"
                id="username"
                name="username"
                autocomplete="username"
                autocapitalize="none"
                autocorrect="off"
                required
              />
            </div>

            <div class="form-group">
              <label class="label" for="password">${esc(t('login.passwordLabel'))}</label>
              <input
                class="input"
                type="password"
                id="password"
                name="password"
                autocomplete="current-password"
                required
              />
              <p class="auth-capslock" id="auth-capslock" role="status" hidden>
                <i data-lucide="arrow-up" aria-hidden="true"></i>
                <span>${esc(t('login.capsLockWarning'))}</span>
              </p>
            </div>

            <div class="form-error" id="form-error" role="alert" tabindex="-1" hidden></div>

            <div class="auth-form__row">
              <a href="/forgot-password" class="auth-link" data-link>${esc(t('login.forgotPassword'))}</a>
            </div>

            <button type="submit" class="btn btn--primary auth-form__submit" id="auth-btn">
              <span class="auth-btn__label">${esc(t('login.loginButton'))}</span>
            </button>

          </form>
        </section>
        <p class="auth-bottom-tagline" id="auth-version"></p>
      </div>
    </main>
  `);

  const form = container.querySelector('#auth-form');
  const errorEl = container.querySelector('#form-error');
  const submitBtn = container.querySelector('#auth-btn');
  const versionEl = container.querySelector('#auth-version');

  container.querySelectorAll('a[data-link]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); window.yuvomi.navigate(a.getAttribute('href')); }));

  // K3: Passwort-Sichtbarkeits-Toggle
  const passwordInput = form.querySelector('#password');
  const passwordWrapper = document.createElement('div');
  passwordWrapper.className = 'input-password-wrapper';
  passwordInput.parentNode.insertBefore(passwordWrapper, passwordInput);
  passwordWrapper.appendChild(passwordInput);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'password-toggle';
  toggleBtn.setAttribute('aria-label', t('login.showPassword'));
  const toggleIcon = document.createElement('i');
  toggleIcon.setAttribute('data-lucide', 'eye');
  toggleIcon.setAttribute('aria-hidden', 'true');
  toggleBtn.appendChild(toggleIcon);
  passwordWrapper.appendChild(toggleBtn);
  if (window.lucide) lucide.createIcons({ el: toggleBtn });

  toggleBtn.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    toggleIcon.setAttribute('data-lucide', isPassword ? 'eye-off' : 'eye');
    toggleBtn.setAttribute('aria-label', t(isPassword ? 'login.hidePassword' : 'login.showPassword'));
    if (window.lucide) lucide.createIcons({ el: toggleBtn });
  });

  // Caps-Lock-Hinweis: eine aktive Feststelltaste ist die häufigste Ursache für
  // vermeintlich falsche Passwörter. Nur am Passwortfeld, nur solange aktiv.
  const capslockEl = container.querySelector('#auth-capslock');
  if (window.lucide) lucide.createIcons({ el: capslockEl });

  const updateCapsLock = (e) => {
    if (typeof e.getModifierState !== 'function') return;
    capslockEl.hidden = !e.getModifierState('CapsLock');
  };
  passwordInput.addEventListener('keydown', updateCapsLock);
  passwordInput.addEventListener('keyup', updateCapsLock);
  passwordInput.addEventListener('blur', () => { capslockEl.hidden = true; });

  setAppBranding(storedAppName);

  // Autofocus nur auf Zeigegeräten (Desktop): spart Rückkehrern den Klick, ohne
  // auf Touch sofort die virtuelle Tastatur hochzureißen und Hero/Branding zu
  // verdecken, bevor der Nutzer sich orientiert hat.
  if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
    container.querySelector('#username').focus();
  }

  fetch(VERSION_URL, { cache: 'no-store' })
    .then((r) => r.json())
    .then((d) => {
      if (d?.app_name) {
        try { localStorage.setItem(APP_NAME_STORAGE_KEY, d.app_name); } catch (_) {}
        // Nur neu anwenden, wenn sich der Name tatsächlich geändert hat –
        // verhindert ein sichtbares Titel-Flackern bei jedem Aufruf.
        if (d.app_name !== storedAppName) setAppBranding(d.app_name);
      }
      // „Passwort vergessen?" wie SSO gaten: nur anbieten, wenn der Server eine
      // Reset-Mail tatsächlich zustellen kann (SMTP + BASE_URL). Sonst Sackgasse.
      if (d?.password_reset_enabled) {
        const forgot = container.querySelector('.auth-form__forgot');
        if (forgot) forgot.hidden = false;
      }
      versionEl.textContent = d?.version ? t('login.version', { version: d.version }) : t('login.tagline');
    })
    .catch(() => {
      if (versionEl) versionEl.textContent = t('login.tagline');
    });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const username = form.username.value.trim();
    const password = form.password.value;

    const usernameInput = form.querySelector('#username');
    const usernameGroup = usernameInput.closest('.form-group');
    const passwordGroup = passwordInput.closest('.form-group');

    usernameGroup.classList.toggle('form-group--error', !username);
    passwordGroup.classList.toggle('form-group--error', !password);
    usernameInput.setAttribute('aria-invalid', String(!username));
    passwordInput.setAttribute('aria-invalid', String(!password));

    if (!username || !password) {
      // Nicht nur rote Rahmen: einen angesagten Grund nennen (auch für SR).
      showError(errorEl, t('login.fillAllFields'));
      if (!username) usernameInput.focus();
      else passwordInput.focus();
      return;
    }

    const labelEl = submitBtn.querySelector('.auth-btn__label');

    submitBtn.disabled = true;
    usernameInput.disabled = true;
    passwordInput.disabled = true;
    labelEl.textContent = t('login.loggingIn');
    const spinner = document.createElement('span');
    spinner.className = 'auth-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    submitBtn.insertBefore(spinner, labelEl);

    try {
      const result = await auth.login(username, password);
      window.yuvomi.navigate('/', result.user);
    } catch (err) {
      // Fehler-Ehrlichkeit: nur 401 heißt „falsche Zugangsdaten". 429 ist die
      // Sperre; alles andere (Status 0 = offline, 5xx = Serverfehler) ist ein
      // Verbindungsproblem – der Nutzer darf nicht fälschlich an sich zweifeln.
      let message;
      if (err.status === 429) message = t('login.tooManyAttempts');
      else if (err.status === 401) message = t('login.invalidCredentials');
      else message = t('login.networkError');
      showError(errorEl, message);

      if (err.status === 401) {
        // Beide Felder markieren (welches falsch ist, verrät der Server aus
        // Sicherheitsgründen nicht) und den Recovery-Weg sichtbar betonen.
        usernameGroup.classList.add('form-group--error');
        passwordGroup.classList.add('form-group--error');
        usernameInput.setAttribute('aria-invalid', 'true');
        passwordInput.setAttribute('aria-invalid', 'true');
        const forgot = container.querySelector('.auth-form__forgot');
        if (forgot && !forgot.hidden) forgot.classList.add('auth-form__forgot--emphasis');
      }

      // Fokus auf die Fehlermeldung, damit auch sehende Tastaturnutzer sie
      // bemerken (nicht nur Screenreader über role="alert").
      errorEl.focus();
    } finally {
      submitBtn.disabled = false;
      usernameInput.disabled = false;
      passwordInput.disabled = false;
      labelEl.textContent = t('login.loginButton');
      spinner.remove();
    }
  });

  form.querySelector('#username').addEventListener('input', (e) => {
    e.currentTarget.closest('.form-group').classList.remove('form-group--error');
    e.currentTarget.removeAttribute('aria-invalid');
  });
  form.querySelector('#password').addEventListener('input', (e) => {
    e.currentTarget.closest('.form-group').classList.remove('form-group--error');
    e.currentTarget.removeAttribute('aria-invalid');
  });
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

