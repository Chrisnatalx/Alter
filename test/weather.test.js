const test = require('node:test');
const assert = require('node:assert/strict');
const { weatherUrl, weatherLabel, parseOpenMeteo, fetchWeather, BA } = require('../src/feeds/weather');

// Respuesta real de Open-Meteo para Buenos Aires (2026-10-25), recortada
const FIXTURE = {
  latitude: -34.622143, longitude: -58.40909, timezone: 'America/Argentina/Buenos_Aires',
  current_units: { time: 'iso8601', interval: 'seconds', temperature_2m: '°C', apparent_temperature: '°C', relative_humidity_2m: '%', weather_code: 'wmo code', wind_speed_10m: 'km/h', is_day: '', precipitation: 'mm' },
  current: { time: '2026-10-25T16:45', interval: 900, temperature_2m: 15.9, apparent_temperature: 12.5, relative_humidity_2m: 48, weather_code: 1, wind_speed_10m: 14.5, is_day: 1, precipitation: 0.0 },
  daily_units: { time: 'iso8601', weather_code: 'wmo code', temperature_2m_max: '°C', temperature_2m_min: '°C', precipitation_probability_max: '%' },
  daily: {
    time: ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'],
    weather_code: [51, 3, 3, 51, 51],
    temperature_2m_max: [17.0, 16.8, 18.0, 19.9, 23.5],
    temperature_2m_min: [11.0, 8.3, 11.9, 12.4, 14.8],
    precipitation_probability_max: [37, 2, 6, 37, 45],
  },
};

test('weatherUrl arma la consulta de Buenos Aires en el orden verificado', () => {
  assert.equal(weatherUrl(), 'https://api.open-meteo.com/v1/forecast?latitude=-34.6037&longitude=-58.3816&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=America%2FArgentina%2FBuenos_Aires&forecast_days=5');
  assert.equal(BA.name, 'Buenos Aires');
});

test('parseOpenMeteo arma el ahora y los próximos días', () => {
  const w = parseOpenMeteo(FIXTURE);
  assert.deepEqual(w.current, { temp: 15.9, feels: 12.5, humidity: 48, wind: 14.5, code: 1, label: 'Mayormente despejado', isDay: true, precip: 0 });
  assert.deepEqual(w.days[0], { date: '2026-10-25', code: 51, label: 'Llovizna', max: 17, min: 11, rainProb: 37 });
  assert.equal(w.days.length, 5);
  assert.equal(w.place, 'Buenos Aires');
});

test('parseOpenMeteo lanza el motivo de un error de la API', () => {
  assert.throws(() => parseOpenMeteo({ error: true, reason: 'x' }), /x/);
});

test('weatherLabel traduce los códigos WMO', () => {
  assert.equal(weatherLabel(0), 'Despejado');
  assert.equal(weatherLabel(95), 'Tormenta');
  assert.equal(weatherLabel(1234), '—');
});

test('fetchWeather rechaza si la respuesta no es ok', async () => {
  await assert.rejects(fetchWeather({ fetchFn: async () => ({ ok: false, status: 503 }) }), /503/);
});

test('fetchWeather pide la URL y parsea la respuesta', async () => {
  let asked = null;
  const w = await fetchWeather({ fetchFn: async (url) => { asked = url; return { ok: true, json: async () => FIXTURE }; } });
  assert.equal(asked, weatherUrl());
  assert.equal(w.current.temp, 15.9);
});
