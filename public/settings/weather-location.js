import { t, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import { toggleRowHtml } from '/settings/components.js';

/**
 * Standortformular für das Wetter-Widget - einmal für den Haushalt
 * (`admin-weather`), einmal je Mitglied (`personal-weather`). Beide Blätter
 * rendern dieselben fünf Felder mit denselben i18n-Keys und hatten
 * `requestLocation` samt Koordinatenvalidierung doppelt implementiert
 * (Critique 2026-07-27).
 *
 * `scope` ist zugleich das id-Präfix der Felder, damit die bestehenden
 * DOM-Verträge (`#weather-lat`, `#pweather-lat`, ...) unverändert bleiben.
 */
export const HOUSEHOLD_WEATHER_SCOPE = 'weather';
export const PERSONAL_WEATHER_SCOPE = 'pweather';

export function isConnectedWeatherControl(control, container) {
  return Boolean(control?.isConnected && container?.isConnected);
}

export function hasValidWeatherCoords(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  return lat !== ''
    && lon !== ''
    && Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}

export function weatherLocationFieldsHtml({ scope, values = {}, autoLocateDisabled = false }) {
  const units = values.units === 'imperial' ? 'imperial' : 'metric';
  return `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="${scope}-lat">${t('settings.weatherLatLabel')}</label>
        <input class="form-input" type="number" id="${scope}-lat" step="any" min="-90" max="90"
          value="${esc(values.lat ?? '')}" placeholder="${t('settings.weatherLatPlaceholder')}">
      </div>
      <div class="form-group">
        <label class="form-label" for="${scope}-lon">${t('settings.weatherLonLabel')}</label>
        <input class="form-input" type="number" id="${scope}-lon" step="any" min="-180" max="180"
          value="${esc(values.lon ?? '')}" placeholder="${t('settings.weatherLonPlaceholder')}">
      </div>
    </div>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--secondary btn--sm" id="${scope}-locate-btn">
        <i data-lucide="map-pin" aria-hidden="true"></i>
        ${t('settings.weatherLocateBtn')}
      </button>
    </div>
    <div class="form-group">
      ${toggleRowHtml({
        label: t('settings.weatherAutoLocateLabel'),
        checked: !!values.auto_locate,
        disabled: autoLocateDisabled,
        attrs: { id: `${scope}-auto-locate` },
      })}
      <p class="form-hint">${t('settings.weatherAutoLocateHint')}</p>
    </div>
    <div class="form-group">
      <label class="form-label" for="${scope}-city">${t('settings.weatherCityLabel')}</label>
      <input class="form-input" type="text" id="${scope}-city" maxlength="100"
        value="${esc(values.city ?? '')}" placeholder="${t('settings.weatherCityPlaceholder')}">
      <p class="form-hint">${t('settings.weatherCityAutoHint')}</p>
    </div>
    <div class="form-group">
      <label class="form-label" for="${scope}-units">${t('settings.weatherUnitsLabel')}</label>
      <select class="form-input" id="${scope}-units">
        <option value="metric"${units === 'metric' ? ' selected' : ''}>${t('settings.weatherUnitsMetric')}</option>
        <option value="imperial"${units === 'imperial' ? ' selected' : ''}>${t('settings.weatherUnitsImperial')}</option>
      </select>
    </div>
  `;
}

export function readWeatherLocation(container, scope) {
  return {
    lat: container.querySelector(`#${scope}-lat`)?.value.trim() ?? '',
    lon: container.querySelector(`#${scope}-lon`)?.value.trim() ?? '',
    city: container.querySelector(`#${scope}-city`)?.value.trim() ?? '',
    units: container.querySelector(`#${scope}-units`)?.value ?? 'metric',
    auto_locate: container.querySelector(`#${scope}-auto-locate`)?.checked ?? false,
  };
}

/**
 * R3 (v0.0.33): Nach erfolgreicher Geolokalisierung die Stadt clientseitig
 * vorbelegen - dieselbe BigDataCloud-Quelle wie der Server (kein Key), Sprache
 * folgt der UI-Locale. Host ist api.bigdatacloud.NET (die Domain der kosten-
 * losen Client-seitigen Endpoints laut api-domains-Doku). Nur bei leerem Feld:
 * eine gespeicherte Stadt ist eine bewusste Entscheidung und wird nie
 * überschrieben. Fehler (Timeout 6s, Netz, fremde Antwort) schweigen - der
 * Server fällt beim ersten Wetter-Load auf denselben Dienst zurück und füllt
 * die Stadt dann serverseitig.
 *
 * @param {HTMLElement} container
 * @param {string} scope
 * @param {number|string} lat
 * @param {number|string} lon
 * @returns {Promise<void>}
 */
async function autoFillCity(container, scope, lat, lon) {
  const cityInput = container.querySelector(`#${scope}-city`);
  if (!cityInput || cityInput.value.trim()) return;
  try {
    const url = [
      'https://api.bigdatacloud.net/data/reverse-geocode-client',
      `?latitude=${encodeURIComponent(lat)}`,
      `&longitude=${encodeURIComponent(lon)}`,
      `&localityLanguage=${encodeURIComponent(getLocale())}`,
    ].join('');
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return;
    const json = await res.json().catch(() => null);
    const name = json?.city || json?.locality || json?.principalSubdivision;
    if (!name) return;
    // Blattwechsel während des Requests: nicht in ein fremdes Formular schreiben.
    if (!isConnectedWeatherControl(cityInput, container)) return;
    cityInput.value = String(name).slice(0, 100);
  } catch {
    /* still: Feld leer lassen, der Server übernimmt beim Wetter-Laden */
  }
}

function requestLocation(container, scope, locateButton) {
  if (!navigator.geolocation) {
    window.yuvomi?.showToast(t('settings.weatherLocateUnsupported'), 'warning');
    return;
  }

  locateButton.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      // Der Callback kann nach einem Blattwechsel eintreffen; dann gehört das
      // Formular nicht mehr zum Dokument und darf nicht mehr beschrieben werden.
      if (!isConnectedWeatherControl(locateButton, container)) return;

      const lat = position.coords.latitude.toFixed(4);
      const lon = position.coords.longitude.toFixed(4);
      container.querySelector(`#${scope}-lat`).value = lat;
      container.querySelector(`#${scope}-lon`).value = lon;
      locateButton.disabled = false;
      window.yuvomi?.showToast(t('settings.weatherLocateSuccess'), 'success');
      // Stadt vorbelegen (nur leeres Feld, still bei Fehlern) - nicht awaited:
      // der Toast darf nicht auf einen Reverse-Geocode-Call warten.
      autoFillCity(container, scope, lat, lon);
    },
    (error) => {
      if (!isConnectedWeatherControl(locateButton, container)) return;

      locateButton.disabled = false;
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    },
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

export function bindWeatherLocationEvents(container, scope) {
  const locateButton = container.querySelector(`#${scope}-locate-btn`);
  locateButton?.addEventListener('click', () => requestLocation(container, scope, locateButton));

  const autoLocate = container.querySelector(`#${scope}-auto-locate`);
  autoLocate?.addEventListener('change', () => {
    if (autoLocate.checked && locateButton) requestLocation(container, scope, locateButton);
  });
}
