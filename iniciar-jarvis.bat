@echo off
title J.A.R.V.I.S.
cd /d "%~dp0"
rem Abre la interfaz en Chrome (o en el navegador por defecto) y levanta el servidor local.
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=http://localhost:7777
) else (
  start "" "http://localhost:7777"
)
node server.js
