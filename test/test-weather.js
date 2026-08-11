import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const BASE_ENV_KEYS = ['OPENWEATHER_API_KEY', 'OPENWEATHER_CITY', 'WEATHER_LAT', 'WEATHER_LON', 'WEATHER_CITY', 'WEATHER_UNITS'];

// Spin up the weather router with injected cfgGet (DB) + fetchFn (upstream).
// Returns { baseUrl, close }.
async function startApp({ env = {}, db = {}, fetchFn, userId } = {}) {
  for (const k of BASE_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);

  const { buildRouter } = await import('../server/routes/weather.js');
  const router = buildRouter({
    cfgGet: (key) => (key in db ? db[key] : null),
    fetchFn,
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (userId) req.authUserId = userId; next(); });
  app.use('/', router);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const OM_FETCH = async (url) => {
  if (new URL(String(url)).hostname !== 'api.open-meteo.com') throw new Error('unexpected URL: ' + url);
  return {
    ok: true,
    json: async () => ({
      current: { temperature_2m: 18.5, apparent_temperature: 16.0, relative_humidity_2m: 65,
        is_day: 1, weather_code: 2, wind_speed_10m: 14.4 },
      daily: {
        time: ['2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09'],
        weather_code: [2, 61, 3, 0, 80],
        temperature_2m_max: [22, 18, 20, 25, 17],
        temperature_2m_min: [14, 12, 13, 16, 11],
      },
    }),
  };
};

const OM_FETCH_NIGHT = async () => ({
  ok: true,
  json: async () => ({
    current: { temperature_2m: 10, apparent_temperature: 8, relative_humidity_2m: 70,
      is_day: 0, weather_code: 0, wind_speed_10m: 5 },
    daily: { time: ['2026-06-05'], weather_code: [0], temperature_2m_max: [12], temperature_2m_min: [8] },
  }),
});

const OWM_FETCH = async (url) => {
  if (String(url).includes('/weather?')) {
    return { ok: true, json: async () => ({
      name: 'Hamburg', main: { temp: 15, feels_like: 13, humidity: 80 },
      weather: [{ icon: '04d', description: 'bedeckt' }], wind: { speed: 4 } }) };
  }
  if (String(url).includes('/forecast?')) {
    return { ok: true, json: async () => ({
      list: [{ dt_txt: '2026-06-06 12:00:00', main: { temp: 16 },
        weather: [{ icon: '10d', description: 'leichter Regen' }] }] }) };
  }
  throw new Error('unexpected URL: ' + url);
};

async function getJson(baseUrl) {
  const res = await fetch(`${baseUrl}/`);
  return { status: res.status, body: await res.json() };
}

test('no provider configured → { data: null }', async () => {
  const { baseUrl, close } = await startApp({});
  try {
    const { status, body } = await getJson(baseUrl);
    assert.equal(status, 200);
    assert.deepEqual(body, { data: null });
  } finally { await close(); }
});

test('Open-Meteo via env: provider + city + cloud-sun icon + wmo desc + forecast shape', async () => {
  const { baseUrl, close } = await startApp({
    env: { WEATHER_LAT: '52.52', WEATHER_LON: '13.41', WEATHER_CITY: 'Berlin' },
    fetchFn: OM_FETCH,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.provider, 'open-meteo');
    assert.equal(body.data.city, 'Berlin');
    assert.equal(body.data.current.icon, 'cloud-sun');
    assert.equal(body.data.current.desc, 'wmo.2');
    const fc = body.data.forecast;
    assert.ok(Array.isArray(fc) && fc.length > 0);
    for (const k of ['date', 'temp_min', 'temp_max', 'icon', 'desc']) assert.ok(k in fc[0]);
  } finally { await close(); }
});

test('DB provider=open-meteo overrides env OPENWEATHER_API_KEY; night → moon', async () => {
  const { baseUrl, close } = await startApp({
    env: { OPENWEATHER_API_KEY: 'old-key' },
    db: { weather_provider: 'open-meteo', weather_lat: '48.14', weather_lon: '11.58', weather_city: 'München' },
    fetchFn: OM_FETCH_NIGHT,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.provider, 'open-meteo');
    assert.equal(body.data.city, 'München');
    assert.equal(body.data.current.icon, 'moon');
  } finally { await close(); }
});

test('OWM legacy via env: provider + raw OWM icon code', async () => {
  const { baseUrl, close } = await startApp({
    env: { OPENWEATHER_API_KEY: 'key123', OPENWEATHER_CITY: 'Hamburg' },
    fetchFn: OWM_FETCH,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.provider, 'openweathermap');
    assert.equal(body.data.city, 'Hamburg');
    assert.equal(body.data.current.icon, '04d');
  } finally { await close(); }
});

test('per-user override beats household coords', async () => {
  const { baseUrl, close } = await startApp({
    db: {
      weather_provider: 'open-meteo',
      weather_lat: '48.14', weather_lon: '11.58', weather_city: 'München',
      'weather_lat:user:7': '52.52', 'weather_lon:user:7': '13.41', 'weather_city:user:7': 'Berlin',
    },
    fetchFn: OM_FETCH,
    userId: 7,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.provider, 'open-meteo');
    assert.equal(body.data.city, 'Berlin');
  } finally { await close(); }
});

test('per-user Open-Meteo coords work without household provider', async () => {
  const { baseUrl, close } = await startApp({
    db: {
      'weather_lat:user:7': '52.52',
      'weather_lon:user:7': '13.41',
      'weather_city:user:7': 'Berlin',
      'weather_units:user:7': 'imperial',
    },
    fetchFn: OM_FETCH,
    userId: 7,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.provider, 'open-meteo');
    assert.equal(body.data.city, 'Berlin');
    assert.equal(body.data.units, 'imperial');
  } finally { await close(); }
});

test('falls back to household coords when user has no override', async () => {
  const { baseUrl, close } = await startApp({
    db: { weather_provider: 'open-meteo', weather_lat: '48.14', weather_lon: '11.58', weather_city: 'München' },
    fetchFn: OM_FETCH,
    userId: 7,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.city, 'München');
  } finally { await close(); }
});
