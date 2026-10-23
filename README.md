# J.A.R.V.I.S.

Interfaz de voz futurista para conversar con Claude usando **tu suscripción**. No usa API key: el servidor local llama a Claude Code en modo headless (`claude -p`), que autentica con tu login.

## Requisitos
- Node 18 o superior
- Claude Code instalado y con sesión iniciada (corré `claude` una vez y hacé login)
- Chrome o Edge (el reconocimiento de voz no funciona en Firefox)

## Uso
En cualquier terminal escribí:

```
jarvis
```

Levanta el servidor y abre la interfaz. Si ya estaba corriendo, solo abre la ventana. Dejá la terminal abierta; Ctrl+C lo apaga.

El comando se registró con `npm link` desde esta carpeta. Si movés la carpeta, volvé a correr `npm link` adentro.

- **Hablá directamente**: JARVIS detecta cuándo empezás y terminás de hablar (tras una pausa corta envía la frase), responde y vuelve a escuchar.
- **ESPACIO** o botón **MICRÓFONO**: prende/apaga la escucha.
- **ESC**, o tocar el núcleo mientras habla: interrumpe la respuesta y vuelve a escucharte.
- Mientras JARVIS habla no escucha, para no oírse a sí mismo por los parlantes.
- **NUEVA**: empieza una conversación sin contexto previo.
- Voz, velocidad y tono se ajustan en el panel izquierdo. En Edge aparecen voces "Natural" más realistas.

## Configuración (variables de entorno)
| Variable | Default | Para qué |
|---|---|---|
| `JARVIS_PORT` | `7777` | Puerto local |
| `JARVIS_MODEL` | modelo por defecto de tu cuenta | p. ej. `sonnet` o `haiku` para respuestas más rápidas |
| `CLAUDE_BIN` | autodetectado | Ruta al ejecutable de Claude Code |

## Notas
- Cada mensaje consume de tu cupo de Claude Code.
- El reconocimiento de voz del navegador procesa el audio en servidores de Google (Chrome) o Microsoft (Edge).
- El servidor solo escucha en `127.0.0.1`. No lo expongas a la red: usa tu cuenta.
- La personalidad se define en `SYSTEM_PROMPT` dentro de `server.js`.
