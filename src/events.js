// Canal de eventos hacia la interfaz (SSE). Hay un solo cliente activo: si se conecta otra
// pestaña, la anterior recibe `replaced` y se cierra. Sin cliente, los eventos se descartan.

const PING_MS = 25000;

function createEventHub({ pingMs = PING_MS } = {}) {
  let client = null; // { res, timer }

  function detach(c) {
    clearInterval(c.timer);
    if (client === c) client = null;
  }

  return {
    attach(res) {
      if (client) {
        const old = client;
        detach(old);
        try { old.res.write('event: replaced\ndata: {}\n\n'); old.res.end(); } catch { /* ya estaba cerrado */ }
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // Comentario periódico para que ni el navegador ni un proxy corten la conexión ociosa
      const timer = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* se limpia en close */ } }, pingMs);
      timer.unref?.();
      const c = { res, timer };
      client = c;
      res.on('close', () => detach(c));
    },
    emit(event, data) {
      if (!client) return;
      try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* el close lo limpia */ }
    },
    hasClient: () => client !== null,
  };
}

module.exports = { createEventHub, PING_MS };
