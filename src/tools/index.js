// Herramientas propias de JARVIS, expuestas al modelo como un servidor MCP en proceso.

const { z } = require('zod');
const { buildOpenUrl, openInBrowser } = require('./browser');
const { findYoutubeVideo } = require('./youtube');

// Se arma por pedido para poder avisarle a la interfaz qué se abrió (`emit`).
function createJarvisTools(sdk, { emit, googleAccount }) {
  return sdk.createSdkMcpServer({
    name: 'jarvis',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'abrir_en_navegador',
        'Abre una página web en una pestaña nueva del navegador de la persona, para mostrarle algo visualmente (su calendario, un mail, un documento, un repo, una búsqueda).',
        { url: z.string().describe('Dirección completa, con https://') },
        async ({ url }) => {
          try {
            const href = buildOpenUrl(url, googleAccount);
            openInBrowser(href);
            console.log(`  [ABIERTO] ${href}`);
            emit('open', { url: href });
            return { content: [{ type: 'text', text: `Abierto en el navegador: ${href}` }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `No pude abrirlo: ${err.message}` }], isError: true };
          }
        },
      ),
      sdk.tool(
        'poner_en_youtube',
        'Reproduce música o un video de YouTube: busca y abre el primer resultado en el navegador. Al usarla, la interfaz apaga el micrófono para que la música no se tome como voz.',
        { busqueda: z.string().describe('Qué buscar, por ejemplo "Queen Bohemian Rhapsody" o "lofi para concentrarse"') },
        async ({ busqueda }) => {
          try {
            const video = await findYoutubeVideo(busqueda);
            // Si no se pudo leer el resultado, al menos abrir la búsqueda para elegir a mano
            const href = buildOpenUrl(video
              ? `https://www.youtube.com/watch?v=${video.id}`
              : `https://www.youtube.com/results?search_query=${encodeURIComponent(busqueda)}`, googleAccount);
            openInBrowser(href);
            console.log(`  [YOUTUBE] ${href}`);
            emit('open', { url: href });
            emit('music', { title: video?.title || '' });
            return { content: [{ type: 'text', text: video
              ? `Reproduciendo «${video.title}» en el navegador. El micrófono quedó apagado: avisale que toque ESPACIO para volver a hablarte.`
              : 'No pude identificar el video; abrí la búsqueda de YouTube para que elija. El micrófono quedó apagado: avisale que toque ESPACIO para volver a hablarte.' }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `No pude abrir YouTube: ${err.message}` }], isError: true };
          }
        },
      ),
    ],
  });
}

module.exports = { createJarvisTools };
