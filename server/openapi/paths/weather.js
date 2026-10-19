import { op } from '../helpers.js';

export function weatherPaths() {
  return {
    '/api/v1/weather': {
      get: op({
        summary: 'Get weather data',
        tag: 'Weather',
        description:
          'Returns `{ data: { provider, city, units, current, forecast } }` or `{ data: null }` when no provider is configured. `provider` is `open-meteo` (icon fields are Lucide icon names, `desc` is a `wmo.<code>` i18n key) or `openweathermap` (legacy; icon fields are OWM icon codes, `desc` is localized text). `city` resolution: a manually configured city (`weather_city`) wins; otherwise, when coordinates are configured but no city is set, the server reverse-geocodes the coordinates (BigDataCloud, no API key required, `localityLanguage` follows the `lang` query parameter) and persists the result to `weather_city`. On failure the server silently falls back to the `"lat, lon"` coordinate string - the response stays 200 with weather data.',
        params: [
          {
            name: 'lang',
            in: 'query',
            required: false,
            description: 'UI language (BCP-47). Used as `localityLanguage` for reverse geocoding; invalid values fall back to the default locale.',
            schema: { type: 'string' },
          },
        ],
      }),
    },
    '/api/v1/weather/icon/{code}': {
      get: op({ summary: 'Get weather icon asset', tag: 'Weather', params: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }] }),
    },
  };
}
