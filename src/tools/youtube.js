// Búsqueda en YouTube sin API key: lee la página de resultados.

// Primer video de la página (sin publicidades ni shorts, que usan otro formato).
// Si YouTube cambia el formato, devuelve null.
function parseYoutubeResults(html) {
  const m = /"videoRenderer":\{"videoId":"([\w-]{11})".*?"title":\{"runs":\[\{"text":"(.*?)"\}/.exec(html);
  if (!m) return null;
  let title = m[2];
  try { title = JSON.parse(`"${title}"`); } catch {} // decodifica escapes como &
  return { id: m[1], title };
}

async function findYoutubeVideo(search, fetchFn = fetch) {
  const res = await fetchFn(`https://www.youtube.com/results?search_query=${encodeURIComponent(search)}`, {
    headers: { 'Accept-Language': 'es-AR,es;q=0.9', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  return parseYoutubeResults(await res.text());
}

module.exports = { parseYoutubeResults, findYoutubeVideo };
