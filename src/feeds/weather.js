// Clima de Buenos Aires desde Open-Meteo (gratis y sin API key para uso no comercial).
// Lo pide el servidor, no el navegador: la página no habla con nadie fuera de 127.0.0.1.

const BA = { name: 'Buenos Aires', lat: -34.6037, lon: -58.3816, timezone: 'America/Argentina/Buenos_Aires' };

const CURRENT = 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day,precipitation';
const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max';

// Códigos WMO que devuelve Open-Meteo → etiqueta corta en español
const LABELS = [
  [[0], 'Despejado'],
  [[1], 'Mayormente despejado'],
  [[2], 'Parcialmente nublado'],
  [[3], 'Nublado'],
  [[45, 48], 'Niebla'],
  [[51, 53, 55], 'Llovizna'],
  [[56, 57], 'Llovizna helada'],
  [[61], 'Lluvia débil'],
  [[63], 'Lluvia'],
  [[65], 'Lluvia fuerte'],
  [[66, 67], 'Lluvia helada'],
  [[71, 73, 75, 77], 'Nieve'],
  [[80, 81, 82], 'Chaparrones'],
  [[85, 86], 'Chaparrones de nieve'],
  [[95], 'Tormenta'],
  [[96, 99], 'Tormenta con granizo'],
];
const LABEL_BY_CODE = new Map(LABELS.flatMap(([codes, label]) => codes.map((c) => [c, label])));

const weatherLabel = (code) => LABEL_BY_CODE.get(code) || '—';

function weatherUrl(place = BA) {
  // URLSearchParams escapa las comas; Open-Meteo las acepta igual, pero así la URL queda legible
  const qs = new URLSearchParams({
    latitude: place.lat, longitude: place.lon, current: CURRENT, daily: DAILY, timezone: place.timezone, forecast_days: 5,
  }).toString().replace(/%2C/g, ',');
  return `https://api.open-meteo.com/v1/forecast?${qs}`;
}

// Respuesta de Open-Meteo → lo que pinta la cara del Clima. Los arrays de `daily` vienen alineados con `time`.
function parseOpenMeteo(json, place = BA) {
  if (json?.error) throw new Error(json.reason || 'Open-Meteo devolvió un error');
  const c = json.current;
  const d = json.daily;
  return {
    place: place.name,
    current: {
      temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m, wind: c.wind_speed_10m,
      code: c.weather_code, label: weatherLabel(c.weather_code), isDay: c.is_day === 1, precip: c.precipitation,
    },
    days: d.time.map((date, i) => ({
      date, code: d.weather_code[i], label: weatherLabel(d.weather_code[i]),
      max: d.temperature_2m_max[i], min: d.temperature_2m_min[i], rainProb: d.precipitation_probability_max[i],
    })),
  };
}

async function fetchWeather({ fetchFn = fetch, place = BA } = {}) {
  const res = await fetchFn(weatherUrl(place), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Open-Meteo respondió ${res.status}`);
  return parseOpenMeteo(await res.json(), place);
}

module.exports = { BA, weatherUrl, weatherLabel, parseOpenMeteo, fetchWeather };
