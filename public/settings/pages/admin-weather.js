import { t } from '/i18n.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import {
  HOUSEHOLD_WEATHER_SCOPE as SCOPE,
  bindWeatherLocationEvents,
  hasValidWeatherCoords,
  readWeatherLocation,
  weatherLocationFieldsHtml,
} from '/settings/weather-location.js';

/**
 * Haushalts-Standardstandort für das Wetter-Widget. Lag bis zum IA-Umbau in
 * `modules-dashboard` neben dem Anwendungsnamen, unter dem Label "Übersicht" -
 * ein Blatt, das keine einzige Widget-Einstellung trug (Critique 2026-07-27).
 * Das Gegenstück je Mitglied ist `personal-weather`; beide teilen sich das
 * Standortformular aus `/settings/weather-location.js`.
 */
function providerLabel(provider) {
  if (provider === 'open-meteo') return t('settings.weatherProviderOpenMeteo');
  if (provider === 'openweathermap') return t('settings.weatherProviderOwm');
  return t('settings.weatherProviderNone');
}

function renderPage(container, preferences) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionWeather')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.weatherTitle')}</h3>
        <p class="settings-card-description">${t('settings.weatherDescription')}</p>
        <div class="settings-sync-info">
          <span class="form-label">${t('settings.weatherActiveProvider')}</span>
          <span class="settings-sync-info__status${preferences.weather_provider === 'open-meteo' ? ' settings-sync-info__status--connected' : ''}">
            ${providerLabel(preferences.weather_provider)}
          </span>
        </div>

        <form class="settings-form settings-form--compact" id="weather-form" novalidate autocomplete="off">
          ${weatherLocationFieldsHtml({
            scope: SCOPE,
            values: {
              lat: preferences.weather_lat,
              lon: preferences.weather_lon,
              city: preferences.weather_city,
              units: preferences.weather_units,
              auto_locate: preferences.weather_auto_locate,
            },
          })}
          <p class="form-hint">${t('settings.weatherCoordHint')}</p>
          <p class="form-hint">${t('settings.weatherSwitchHint')}</p>
          <p class="form-hint">${t('settings.householdWeatherOverrideHint')}</p>
          <div id="weather-form-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${t('settings.weatherSave')}</button>
            ${preferences.weather_provider === 'open-meteo' ? `
              <button type="button" class="btn btn--danger" id="weather-remove-btn">${t('settings.weatherRemove')}</button>
            ` : ''}
          </div>
        </form>
      </div>
    </section>
  `);
}

function bindWeatherEvents(container, user) {
  const form = container.querySelector('#weather-form');
  const errorElement = container.querySelector('#weather-form-error');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    const location = readWeatherLocation(container, SCOPE);
    if (!hasValidWeatherCoords(location.lat, location.lon)) {
      errorElement.textContent = `${t('settings.weatherLatLabel')} / ${t('settings.weatherLonLabel')}`;
      errorElement.hidden = false;
      return;
    }

    try {
      await savePreferences({
        weather_lat: location.lat,
        weather_lon: location.lon,
        weather_city: location.city,
        weather_units: location.units,
        weather_provider: 'open-meteo',
        weather_auto_locate: location.auto_locate,
      });
      window.yuvomi?.showToast(t('settings.weatherSaved'), 'success');
      await render(container, { user });
    } catch (error) {
      errorElement.textContent = error.message || t('common.errorGeneric');
      errorElement.hidden = false;
    }
  });

  container.querySelector('#weather-remove-btn')?.addEventListener('click', async () => {
    try {
      await savePreferences({ weather_provider: null });
      window.yuvomi?.showToast(t('settings.weatherRemoved'), 'success');
      await render(container, { user });
    } catch (error) {
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    }
  });

  bindWeatherLocationEvents(container, SCOPE);
}

export async function render(container, { user }) {
  const preferences = await getPreferences();
  renderPage(container, preferences);
  bindWeatherEvents(container, user);
  window.lucide?.createIcons({ el: container });
}
