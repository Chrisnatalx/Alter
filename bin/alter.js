#!/usr/bin/env node
// Comando `alter`: levanta el servidor y abre la interfaz.
// Si ya hay un ALTER corriendo en el puerto, solo abre la ventana.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
require('../env'); // antes de leer ALTER_PORT, para que también valga desde .env

const PORT = Number(process.env.ALTER_PORT || 7777);
const URL = `http://localhost:${PORT}`;

// Abre Chrome en modo app (ventana sin barras); si no está, usa el navegador por defecto.
function openUi() {
  const chrome = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  if (process.platform === 'win32' && fs.existsSync(chrome)) {
    spawn(chrome, [`--app=${URL}`], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [URL], { detached: true, stdio: 'ignore' }).unref();
  }
}

const probe = http.get(URL, (res) => {
  res.resume();
  console.log(`  ALTER ya está corriendo → ${URL}`);
  openUi();
});
probe.on('error', () => {
  const { server } = require('../server.js');
  server.on('listening', () => {
    console.log('  Dejá esta terminal abierta. Ctrl+C para apagar.\n');
    openUi();
  });
});
