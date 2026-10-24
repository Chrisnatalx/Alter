// Abrir páginas en el navegador por defecto. Lo hace el servidor y no la página porque el
// navegador bloquea las ventanas que no salen de un clic (acá la orden llega por voz).

const childProcess = require('child_process');

// Solo http/https: nada de file:, programas ni protocolos raros.
// En dominios de Google agrega la cuenta (authuser) si hay varias en el navegador.
function buildOpenUrl(rawUrl, googleAccount) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Solo se pueden abrir direcciones http o https.');
  if (googleAccount && /(^|\.)google\.com$/i.test(url.hostname) && !url.searchParams.has('authuser')) {
    url.searchParams.set('authuser', googleAccount);
  }
  return url.toString();
}

// `spawnFn` se inyecta para poder probarlo sin abrir nada.
function openInBrowser(href, spawnFn = childProcess.spawn) {
  // rundll32 no pasa por cmd, así que los & de la URL no se interpretan como comandos
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', href]]
    : process.platform === 'darwin' ? ['open', [href]] : ['xdg-open', [href]];
  const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore' });
  // Si falta el programa que abre el navegador, el error no debe tumbar el servidor
  child.on?.('error', (err) => console.error('  [ERROR] No pude abrir el navegador:', err.message));
  child.unref();
}

module.exports = { buildOpenUrl, openInBrowser };
