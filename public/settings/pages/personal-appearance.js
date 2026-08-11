import {
  getLocale,
  getSupportedLocales,
  setLocale,
  t,
} from '/i18n.js';
import { esc } from '/utils/html.js';
import { appendCurrencyOptions, persistCurrencySelection } from '/settings/currency.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import {
  CUSTOM_REGION,
  REGION_CODES,
  REGION_PRESETS,
  detectRegion,
  resolveRegion,
  regionLabel,
  numberLocaleFor,
} from '/settings/region-presets.js';

const DATE_FORMATS = [
  ['mdy', 'MM/DD/YYYY'],
  ['dmy', 'DD.MM.YYYY'],
  ['dmy_slash', 'DD/MM/YYYY'],
  ['ymd', 'YYYY-MM-DD'],
  ['mdy_dot', 'MM.DD.YYYY'],
  ['ymd_dot', 'YYYY.MM.DD'],
  ['ymd_slash', 'YYYY/MM/DD'],
];

function safeStorageGet(key, fallback = null) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function safeStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function currentTheme() {
  return safeStorageGet('yuvomi-theme', 'system') || 'system';
}

function formatOptions(selected) {
  return DATE_FORMATS.map(([value, label]) => (
    `<option value="${value}"${selected === value ? ' selected' : ''}>${label}</option>`
  )).join('');
}

function regionOptions(selectedRegion) {
  const locale = getLocale();
  // Nach dem angezeigten Namen sortieren, nicht nach der Reihenfolge in
  // REGION_PRESETS: die ist nach Sprachfamilie gruppiert und war bei einem
  // Dutzend Einträgen noch überschaubar. Mit der Amerika-Abdeckung sind es
  // über 60 - da findet man "Spanisch (Peru)" nur alphabetisch wieder.
  // detectRegion() bleibt von der Sortierung unberührt, es liest das Objekt.
  const presets = [...REGION_CODES]
    .map((code) => ({ code, label: regionLabel(code, locale) }))
    .sort((a, b) => a.label.localeCompare(b.label, locale))
    .map(({ code, label }) => (
      `<option value="${esc(code)}"${selectedRegion === code ? ' selected' : ''}>${esc(label)}</option>`
    )).join('');
  const custom = `<option value="${CUSTOM_REGION}"${selectedRegion === CUSTOM_REGION ? ' selected' : ''}>${t('settings.regionCustom')}</option>`;
  return presets + custom;
}

function localeLabel(locale) {
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'language' }).of(locale) || locale;
  } catch {
    return locale;
  }
}

function localeOptions() {
  const storedLocale = safeStorageGet('yuvomi-locale');
  return [
    `<option value="system"${storedLocale ? '' : ' selected'}>${t('settings.localeSystem')}</option>`,
    ...getSupportedLocales().map((locale) => (
      `<option value="${esc(locale)}"${storedLocale === locale ? ' selected' : ''}>${esc(localeLabel(locale))}</option>`
    )),
  ].join('');
}

/**
 * Optionen für die Datensprache des Haushalts (#631, #632). Der leere Wert steht
 * für "automatisch"; sein Label nennt die Sprache, auf die die Automatik fiele -
 * `language_auto`, nicht `language_effective`. Bei explizit gewählter Sprache
 * sind die beiden verschieden, und `language_effective` würde dort genau die
 * gewählte Sprache als Automatik-Ergebnis ausgeben.
 */
function dataLanguageOptions(selected, auto_) {
  const auto = t('settings.dataLanguageAuto', { language: localeLabel(auto_) });
  return [
    `<option value=""${selected ? '' : ' selected'}>${esc(auto)}</option>`,
    ...getSupportedLocales().map((locale) => (
      `<option value="${esc(locale)}"${selected === locale ? ' selected' : ''}>${esc(localeLabel(locale))}</option>`
    )),
  ].join('');
}

function showError(element, message) {
  if (!element) return;
  element.textContent = message || t('common.errorGeneric');
  element.hidden = false;
}

function clearError(element) {
  if (!element) return;
  element.textContent = '';
  element.hidden = true;
}

function renderLoadError(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="settings-card">
      <p class="form-error" role="alert">${t('settings.loadError')}</p>
      <div class="settings-form-actions">
        <button type="button" class="btn btn--secondary" id="appearance-retry">${t('settings.retry')}</button>
      </div>
    </div>
  `);
}

/**
 * Region, Währung, Datums- und Zeitformat bleiben eine Gruppe, obwohl sie sich
 * in der Berechtigung teilen: Region und Währung schreiben nur Admins, die
 * beiden Formate darf jedes Mitglied ändern (`server/routes/preferences.js:351`
 * dokumentiert das ausdrücklich). Zwei Gründe gegen eine Trennung:
 *
 * 1. Der Region-Select setzt die anderen drei Werte mit (`syncRegionSelect` /
 *    `detectRegion`) - auseinandergezogen reißt das #486 wieder auf.
 * 2. Die ganze Gruppe nach `admin` zu schieben nähme Mitgliedern genau das
 *    Formatändern, das die Route ihnen gewährt.
 *
 * Der Preis ist, dass ein "persönliches" Blatt vier haushaltweite Werte
 * schreibt. Das trägt die Copy (`regionAdminOnly`, `formatsHouseholdHint`),
 * nicht die Struktur (Critique 2026-07-27).
 */
function renderPage(container, preferences, isAdmin) {
  const theme = currentTheme();
  const activeRegion = resolveRegion(preferences);
  const customHidden = isAdmin && activeRegion !== CUSTOM_REGION;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionDesign')}</h2>
      <div class="settings-card">
        <div class="theme-toggle" id="theme-toggle">
          <button class="theme-toggle__btn ${theme === 'system' ? 'theme-toggle__btn--active' : ''}" type="button" data-theme-value="system" aria-label="${t('settings.themeSysLabel')}" aria-pressed="${theme === 'system'}">
            <i data-lucide="monitor" class="icon-md" aria-hidden="true"></i>
            ${t('settings.themeSystem')}
          </button>
          <button class="theme-toggle__btn ${theme === 'light' ? 'theme-toggle__btn--active' : ''}" type="button" data-theme-value="light" aria-label="${t('settings.themeLightLabel')}" aria-pressed="${theme === 'light'}">
            <i data-lucide="sun" class="icon-md" aria-hidden="true"></i>
            ${t('settings.themeLight')}
          </button>
          <button class="theme-toggle__btn ${theme === 'dark' ? 'theme-toggle__btn--active' : ''}" type="button" data-theme-value="dark" aria-label="${t('settings.themeDarkLabel')}" aria-pressed="${theme === 'dark'}">
            <i data-lucide="moon" class="icon-md" aria-hidden="true"></i>
            ${t('settings.themeDark')}
          </button>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.languageTitle')}</h2>
      <div class="settings-card">
        <div class="form-group">
          <label class="form-label" for="locale-select">${t('settings.localeLabel')}</label>
          <select class="form-input locale-picker__select" id="locale-select" aria-describedby="locale-error">
            ${localeOptions()}
          </select>
        </div>
        <div id="locale-error" class="form-error" role="alert" hidden></div>
      </div>
      <!-- Eigene Karte, nicht angehängt an die Sprachauswahl darüber: als
           Nachbar im selben Block läse sich der Hinweis wie die Erklärung der
           Anzeigesprache - und beide sagen etwas Gegensätzliches aus. -->
      <div class="settings-card">
        ${isAdmin ? `
        <p class="form-hint" id="data-language-hint">${t('settings.dataLanguageHint')}</p>
        <div class="form-group">
          <label class="form-label" for="data-language-select">${t('settings.dataLanguageLabel')}</label>
          <select class="form-input" id="data-language-select" aria-describedby="data-language-hint data-language-error">
            ${dataLanguageOptions(preferences.language, preferences.language_auto)}
          </select>
        </div>
        <div id="data-language-error" class="form-error" role="alert" hidden></div>` : `
        <p class="form-hint">${t('settings.dataLanguageAdminOnly')}</p>`}
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.regionTitle')}</h2>
      ${isAdmin ? `
      <div class="settings-card">
        <p class="form-hint" id="region-hint">${t('settings.regionHint')}</p>
        <div class="form-group">
          <label class="form-label" for="region-select">${t('settings.regionLabel')}</label>
          <select class="form-input" id="region-select" aria-describedby="region-hint region-error">
            ${regionOptions(activeRegion)}
          </select>
        </div>
        <div id="region-error" class="form-error" role="alert" hidden></div>
      </div>` : `
      <div class="settings-card">
        <p class="form-hint">${t('settings.regionAdminOnly')}</p>
      </div>`}
      <div class="settings-card" id="custom-formats"${customHidden ? ' hidden' : ''}>
        ${isAdmin ? `
        <div class="form-group">
          <label class="form-label" for="currency-select">${t('settings.currencyLabel')}</label>
          <select class="form-input" id="currency-select" aria-describedby="currency-error"></select>
        </div>
        <div id="currency-error" class="form-error" role="alert" hidden></div>` : ''}
        <p class="form-hint" id="formats-household-hint">${t('settings.formatsHouseholdHint')}</p>
        <div class="form-group">
          <label class="form-label" for="date-format-select">${t('settings.dateFormatLabel')}</label>
          <select class="form-input" id="date-format-select" aria-describedby="formats-household-hint date-format-error">
            ${formatOptions(preferences.date_format)}
          </select>
        </div>
        <div id="date-format-error" class="form-error" role="alert" hidden></div>
        <div class="form-group">
          <label class="form-label" for="time-format-select">${t('settings.timeFormatLabel')}</label>
          <select class="form-input" id="time-format-select" aria-describedby="formats-household-hint time-format-error">
            <option value="24h"${preferences.time_format === '24h' ? ' selected' : ''}>24 ${t('settings.timeFormatHours')}</option>
            <option value="12h"${preferences.time_format === '12h' ? ' selected' : ''}>AM/PM</option>
          </select>
        </div>
        <div id="time-format-error" class="form-error" role="alert" hidden></div>
      </div>
    </section>
  `);
}

function applyTheme(value) {
  safeStorageSet('yuvomi-theme', value);
  if (window.yuvomi?.applyTheme) {
    try {
      window.yuvomi.applyTheme(value);
      return;
    } catch {
      // Fall back to applying the theme directly when router storage fails.
    }
  }

  if (value === 'dark' || value === 'light') {
    document.documentElement.setAttribute('data-theme', value);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

// Spiegelt die aktive Region als Formatier-Locale für Zahlen/Währung in den
// localStorage (getFormatLocale() in i18n.js liest ihn). Leert den Schlüssel bei
// "Benutzerdefiniert", damit die Zahlenformatierung auf die UI-Sprache zurückfällt.
function applyNumberLocale({ region, currency, date_format, time_format }) {
  const numberLocale = numberLocaleFor({ region, currency, date_format, time_format });
  if (numberLocale) {
    safeStorageSet('yuvomi-number-locale', numberLocale);
  } else {
    safeStorageRemove('yuvomi-number-locale');
  }
}

// Liest den aktuellen Format-Zustand aus den vier Selects der Seite.
function readFormatState(container) {
  return {
    region: container.querySelector('#region-select')?.value,
    currency: container.querySelector('#currency-select')?.value,
    date_format: container.querySelector('#date-format-select')?.value,
    time_format: container.querySelector('#time-format-select')?.value,
  };
}

// Hält den Region-Dropdown mit den drei Einzel-Selects synchron (Preset oder
// "Benutzerdefiniert"), nachdem ein Einzelwert manuell geändert wurde.
function syncRegionSelect(container) {
  const regionSelect = container.querySelector('#region-select');
  if (!regionSelect) return;
  regionSelect.value = detectRegion({
    currency: container.querySelector('#currency-select')?.value,
    date_format: container.querySelector('#date-format-select')?.value,
    time_format: container.querySelector('#time-format-select')?.value,
  });
}

/**
 * Baut die Optionen der Datensprache neu auf. Nötig nach einem Regionswechsel:
 * steht die Datensprache auf "automatisch", leitet der Server sie aus der Region
 * ab, und das Label nennt dann eine andere Sprache. Die Ableitung bleibt dabei
 * beim Server - hier wird nur der frisch gelesene Wert angezeigt, statt die
 * Regel im Client zu wiederholen.
 */
async function refreshDataLanguageOptions(container) {
  const select = container.querySelector('#data-language-select');
  if (!select) return;
  const preferences = await getPreferences();
  select.replaceChildren();
  select.insertAdjacentHTML('beforeend', dataLanguageOptions(
    preferences.language || null,
    preferences.language_auto || 'en',
  ));
}

function bindEvents(container, user) {
  const themeToggle = container.querySelector('#theme-toggle');
  themeToggle?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-theme-value]');
    if (!button) return;
    applyTheme(button.dataset.themeValue);
    themeToggle.querySelectorAll('.theme-toggle__btn').forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle('theme-toggle__btn--active', active);
      candidate.setAttribute('aria-pressed', String(active));
    });
  });

  const localeSelect = container.querySelector('#locale-select');
  localeSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#locale-error');
    clearError(errorElement);
    localeSelect.disabled = true;
    try {
      if (localeSelect.value === 'system') {
        safeStorageRemove('yuvomi-locale');
        location.reload();
        return;
      }
      const locale = localeSelect.value;
      await setLocale(locale);
      await render(container, { user });
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      if (localeSelect.isConnected) localeSelect.disabled = false;
    }
  });

  // Datensprache: anders als der Locale-Picker darüber schreibt sie eine
  // haushaltweite Preference und betitelt serverseitig die bereits gespeicherten
  // Geburtstags-Termine um. Danach neu rendern, damit das Automatik-Label die
  // eventuell veränderte Ableitung zeigt.
  const dataLanguageSelect = container.querySelector('#data-language-select');
  let persistedDataLanguage = dataLanguageSelect?.value ?? '';
  dataLanguageSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#data-language-error');
    clearError(errorElement);
    dataLanguageSelect.disabled = true;
    try {
      await savePreferences({ language: dataLanguageSelect.value || null });
      persistedDataLanguage = dataLanguageSelect.value;
      // Nur die Optionen neu aufbauen statt die Seite: ein voller Re-Render nähme
      // dem gerade bedienten Select den Fokus und würde eine noch nicht
      // gespeicherte "Benutzerdefiniert"-Wahl im Region-Block wieder zuklappen.
      await refreshDataLanguageOptions(container);
      window.yuvomi?.showToast(t('settings.dataLanguageSaved'), 'success');
    } catch (error) {
      // Zurück auf den gespeicherten Wert: sonst zeigt die Seite eine
      // Datensprache an, die nie geschrieben wurde.
      dataLanguageSelect.value = persistedDataLanguage;
      showError(errorElement, error.message);
    } finally {
      if (dataLanguageSelect.isConnected) dataLanguageSelect.disabled = false;
    }
  });

  const regionSelect = container.querySelector('#region-select');
  regionSelect?.addEventListener('change', async () => {
    const customBlock = container.querySelector('#custom-formats');
    if (regionSelect.value === CUSTOM_REGION) {
      if (customBlock) customBlock.hidden = false;
      return;
    }
    const preset = REGION_PRESETS[regionSelect.value];
    if (!preset) return;
    const errorElement = container.querySelector('#region-error');
    clearError(errorElement);
    regionSelect.disabled = true;
    try {
      await savePreferences({
        currency: preset.currency,
        date_format: preset.date_format,
        time_format: preset.time_format,
        // Gewählte Region mitspeichern, sonst würde detectRegion() beim
        // nächsten Laden auf die erste Region mit gleichem Triple springen (#486).
        region: regionSelect.value,
      });
      const currencySelect = container.querySelector('#currency-select');
      if (currencySelect) currencySelect.value = preset.currency;
      const dateSelect = container.querySelector('#date-format-select');
      if (dateSelect) dateSelect.value = preset.date_format;
      const timeSelect = container.querySelector('#time-format-select');
      if (timeSelect) timeSelect.value = preset.time_format;
      safeStorageSet('yuvomi-date-format', preset.date_format);
      safeStorageSet('yuvomi-time-format', preset.time_format);
      applyNumberLocale({
        region: regionSelect.value,
        currency: preset.currency,
        date_format: preset.date_format,
        time_format: preset.time_format,
      });
      window.dispatchEvent(new CustomEvent('date-format-changed', {
        detail: { dateFormat: preset.date_format },
      }));
      window.dispatchEvent(new CustomEvent('time-format-changed', {
        detail: { timeFormat: preset.time_format },
      }));
      if (customBlock) customBlock.hidden = true;
      // Scheitert das Nachladen, bleibt nur das Automatik-Label stale - kein
      // Grund, den erfolgreichen Regionswechsel als Fehler zu melden.
      await refreshDataLanguageOptions(container).catch(() => {});
      window.yuvomi?.showToast(t('settings.regionSaved'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      if (regionSelect.isConnected) regionSelect.disabled = false;
    }
  });

  const currencySelect = container.querySelector('#currency-select');
  let persistedCurrency = currencySelect?.value;
  currencySelect?.addEventListener('change', async () => {
    if (currencySelect.disabled) return;
    const errorElement = container.querySelector('#currency-error');
    clearError(errorElement);
    try {
      await persistCurrencySelection(
        currencySelect,
        persistedCurrency,
        () => savePreferences({ currency: currencySelect.value }),
      );
      persistedCurrency = currencySelect.value;
      syncRegionSelect(container);
      applyNumberLocale(readFormatState(container));
      window.yuvomi?.showToast(t('settings.currencySaved'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    }
  });

  const dateFormatSelect = container.querySelector('#date-format-select');
  dateFormatSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#date-format-error');
    clearError(errorElement);
    dateFormatSelect.disabled = true;
    try {
      await savePreferences({ date_format: dateFormatSelect.value });
      safeStorageSet('yuvomi-date-format', dateFormatSelect.value);
      window.dispatchEvent(new CustomEvent('date-format-changed', {
        detail: { dateFormat: dateFormatSelect.value },
      }));
      syncRegionSelect(container);
      applyNumberLocale(readFormatState(container));
      window.yuvomi?.showToast(t('settings.dateFormatSavedToast'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      dateFormatSelect.disabled = false;
    }
  });

  const timeFormatSelect = container.querySelector('#time-format-select');
  timeFormatSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#time-format-error');
    clearError(errorElement);
    timeFormatSelect.disabled = true;
    try {
      await savePreferences({ time_format: timeFormatSelect.value });
      safeStorageSet('yuvomi-time-format', timeFormatSelect.value);
      window.dispatchEvent(new CustomEvent('time-format-changed', {
        detail: { timeFormat: timeFormatSelect.value },
      }));
      syncRegionSelect(container);
      applyNumberLocale(readFormatState(container));
      window.yuvomi?.showToast(t('settings.timeFormatSavedToast'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      timeFormatSelect.disabled = false;
    }
  });
}

export async function render(container, { user }) {
  try {
    const loaded = await getPreferences();
    const preferences = {
      currency: loaded.currency || 'EUR',
      date_format: loaded.date_format || 'dmy',
      time_format: loaded.time_format || '24h',
      region: loaded.region || null,
      language: loaded.language || null,
      language_auto: loaded.language_auto || 'en',
    };

    safeStorageSet('yuvomi-date-format', preferences.date_format);
    safeStorageSet('yuvomi-time-format', preferences.time_format);
    applyNumberLocale(preferences);
    const isAdmin = user?.role === 'admin';
    renderPage(container, preferences, isAdmin);
    if (isAdmin) {
      appendCurrencyOptions(container.querySelector('#currency-select'), preferences.currency);
    }
    bindEvents(container, user);
    window.lucide?.createIcons({ el: container });
  } catch {
    renderLoadError(container);
    container.querySelector('#appearance-retry')?.addEventListener('click', () => {
      render(container, { user });
    });
  }
}
