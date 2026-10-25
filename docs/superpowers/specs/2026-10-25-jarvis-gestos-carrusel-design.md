# JARVIS: gestos con la mano y carrusel de vistas: diseño

Fecha: 2026-10-25 · Estado: borrador

## Intención

La persona quiere manejar JARVIS con la mano, frente a la webcam, además de la voz. La idea salió de un reel de Instagram (@ingenia.ai, proyecto atribuido a @sagar_builds) con efectos hechos con los dedos. No se pudo ver el video: solo su descripción. Hay dos cosas:

1. **Pellizcar** para hacer zoom sobre el núcleo de partículas y moverlo.
2. **Girar la pantalla con la mano**: un gesto brusco y deliberado de derecha a izquierda rota un carrusel de vistas (Núcleo → Calendar → Mail). Un gesto hacia arriba muestra el Clima de Buenos Aires.

El éxito es que la persona mire su semana, su bandeja o el clima con un gesto, en el acto, y que pueda seguir hablándole a JARVIS desde cualquier vista.

## Estado actual (verificado en el código)

- El frontend es JS puro, sin build: `public/index.html`, `public/app.js` (~1000 líneas), `public/style.css`. El núcleo es un canvas 2D con proyección 3D propia (`app.js`, sección «NÚCLEO DE PARTÍCULAS»). El HUD es un SVG con anillos (`#hud`).
- El micrófono ya se pide con `getUserMedia` (`ensureMicMeter`). La voz entra por Web Speech API y sale por `speechSynthesis`, frase por frase.
- Calendar y Gmail solo son accesibles a través de los conectores de claude.ai (`mcp__claude_ai_Google_Calendar__*`, `mcp__claude_ai_Gmail__*`) dentro de una sesión del Agent SDK. Hoy los usan los subagentes `agenda` y `correo` (`src/agents/`).
- El SDK 0.3.296 define un control request `mcp_call` (`sdk.d.ts:4699`), pero `Query` no expone ningún método que lo use. **No se usa**: es interno.
- El servidor expone `/api/message`, `/api/new`, `/api/interrupt`, `/api/confirm`, `/api/tasks/stop` y el canal SSE `/api/events`, todo con el token `X-Jarvis-Token` (`src/server.js`).

## Objetivos

1. **Cámara siempre activa** mientras JARVIS está abierto, con seguimiento de manos local en el navegador. El video no sale de la máquina y no se muestra en pantalla.
2. **Pellizco, como en el celular**: abrir y cerrar pulgar e índice agranda o achica el núcleo y las partículas, de forma continua. **Juntar los dedos del todo agarra el núcleo**, y mover la mano así lo arrastra. **Al soltar, el núcleo vuelve solo a su lugar y el zoom vuelve a 1**, con una animación suave.
3. **Carrusel 3D** de caras: Núcleo, Calendar y Mail. Un gesto brusco de derecha a izquierda gira a la cara siguiente. El giro se ve como una rotación, no como un corte seco.
4. **Clima** arriba, fuera del anillo, con un gesto brusco hacia arriba.
5. **Las direcciones son las de la persona**: si mueve la mano hacia su izquierda, la pantalla gira hacia su izquierda. La imagen de la webcam viene sin espejar respecto de su punto de vista, así que hay que convertir las coordenadas.
6. **Gesticular al hablar no dispara nada**: solo cuenta un movimiento brusco (umbral de velocidad y recorrido).
7. **Contenido de las vistas**:
   - Calendar: la semana entera (lunes a domingo de la semana actual) con los eventos de cada día.
   - Mail: la bandeja de entrada (últimos hilos de INBOX: remitente, asunto, no leído o leído).
   - Clima de Buenos Aires: el tiempo de ahora y los próximos días.
8. **La voz funciona en todas las vistas**. Mientras hay una vista abierta queda un **núcleo chiquito en una esquina** que cambia de color con el estado (escuchando, pensando, hablando) como el grande.
9. **JARVIS sabe qué vista está mirando la persona**. En Mail, «respondé el segundo» se refiere al segundo hilo de la lista que se ve. Las confirmaciones de envío y borrado siguen igual que hoy.
10. **Giro instantáneo**: los datos de Calendar y Mail se traen en segundo plano y quedan guardados en el servidor. Girar no lanza un turno de Claude.
11. Un indicador de **«mano detectada»** y **puntitos de posición** que marcan en qué cara está la persona.
12. README actualizado: permiso de cámara, gestos disponibles y cómo apagar la cámara.

## No objetivos

- Mostrar el video de la cámara en pantalla.
- Más gestos que los de arriba: puño para interrumpir, pulgar arriba para confirmar y similares quedan para después.
- Interactuar con las vistas con la mano (abrir un mail o hacer scroll con gestos). Dentro de una vista se actúa por voz.
- Otras ciudades para el clima, o una ciudad configurable más allá de lo mínimo.
- Acceso propio a Google con OAuth.

## Anti-objetivos (sería un fracaso aunque funcione)

- Que la vista cambie sola mientras la persona habla y gesticula.
- Que girar tarde segundos o gaste un turno de la conversación.
- Que el seguimiento de manos haga ir lento al núcleo de partículas o a la voz.
- Que la cámara mande imágenes fuera de la máquina.

## Decisiones tomadas por la persona

- El giro es **tipo carrusel**.
- El pellizco funciona **como en el celular**: abrir y cerrar los dedos hace zoom, y juntarlos del todo agarra el núcleo para arrastrarlo.
- Al soltar, el núcleo **vuelve a su lugar** y el **zoom vuelve a 1**.
- La cámara está **siempre activa**.
- Calendar muestra **la semana entera**. Mail muestra **la bandeja de entrada**. El Clima muestra **ahora y los próximos días**.
- Desde las vistas se le puede **hablar** a JARVIS.
- El **núcleo chiquito** queda en las vistas.
- Sin efecto espejo: las direcciones son las de la persona.

## Decisiones tomadas por Claude (revisables)

- **Seguimiento de manos**: MediaPipe Tasks Vision (`HandLandmarker`, 21 puntos por mano) en el navegador. Se sirve desde `node_modules` o se vendoriza en `public/`, sin depender de una CDN en tiempo de ejecución. Hay que verificar la versión estable y el peso del modelo `.task` antes de fijarla.
- **Gesto inverso**: de izquierda a derecha vuelve una cara atrás. El anillo es circular: después de Mail viene el Núcleo. Desde el Clima, un gesto brusco hacia abajo vuelve a la cara anterior.
- **Detección del giro**: se toma la muñeca o el centro de la palma. Cuenta como giro cuando el recorrido horizontal supera ~35 % del ancho del cuadro en menos de ~300 ms, con el desplazamiento vertical chico. Después hay un enfriamiento de ~800 ms. Los valores son iniciales y se ajustan probando.
- **Pellizco**: distancia entre la punta del pulgar y la del índice, normalizada por el tamaño de la mano. El zoom la sigue cuando la mano está en «pose de pellizco» (pulgar e índice extendidos y el resto de los dedos recogidos), para que una mano abierta cualquiera no haga zoom. «Agarrado» es cuando la distancia baja de un umbral, con histéresis (umbrales distintos para entrar y salir) para que no titile. «Soltar» es salir de la pose de pellizco o perder la mano. Mientras dura el pellizco, el giro está desactivado.
- **Datos de Calendar y Mail**: una **query aparte del Agent SDK**, separada de la conversación, con `haiku`, solo las herramientas de lectura de Calendar y Gmail, sin el system prompt de JARVIS y con salida JSON validada con `zod`. Corre al iniciar y cada ~10 minutos. El servidor guarda el último resultado en memoria y lo entrega por un endpoint nuevo con token. Consume cupo de la suscripción: hay que medir cuánto.
- **Clima**: Open-Meteo (gratis, sin API key), pedido desde el servidor con las coordenadas de Buenos Aires. Hay que verificar los endpoints y los campos antes de usarlos.
- **Contexto de la vista para JARVIS**: cuando la persona habla con una vista abierta, el mensaje que se encola lleva una línea como `[Vista en pantalla: Mail; hilos visibles: 1) …, 2) …]`, igual que ya lleva la fecha y la hora (`session.send`).
- **Apagar la cámara**: botón y atajo de teclado en la interfaz. La preferencia se guarda en `localStorage`.
- **Lista de Mail estable**: mientras la cara de Mail está abierta, la lista visible no cambia aunque llegue un refresco. Se actualiza al volver a entrar. La línea de contexto lleva el **id de cada hilo** además de su posición, así «respondé el segundo» apunta a un hilo exacto y no a una búsqueda nueva. Si JARVIS responde, archiva o borra algo, se pide un refresco inmediato.
- **Cuándo se refresca**: solo mientras haya un navegador conectado a `/api/events`. Se refresca al conectar, cada ~10 minutos y al volver a enfocar la pestaña si los datos tienen más de 5 minutos. Cada cara muestra «actualizado hace X min». Si el cupo medido resulta alto, primero se alarga el intervalo; el giro sigue siendo instantáneo con datos un poco más viejos.
- **Qué calendarios**: todos los que la cuenta tiene visibles (`list_calendars`). Los eventos de día completo van arriba de cada día y los rechazados no se muestran.
- **Mano que entra al cuadro**: el movimiento de una mano que recién aparece no cuenta como gesto. Hace falta que esté detectada de forma estable unos ~200 ms.

## Lo que queda a criterio de quien implementa

- El estilo visual de cada cara, dentro de la estética HUD actual (tokens de `style.css`).
- Cuántos hilos de la bandeja entran en la cara de Mail.
- La forma exacta del endpoint de datos y del JSON.
- Si el render del carrusel usa CSS 3D, el mismo canvas o una mezcla.

## Riesgos y preguntas abiertas

- **Costo de CPU** de MediaPipe junto al canvas de partículas: hay que medirlo. Si se nota, se baja la frecuencia de detección (por ejemplo, 15 fps).
- **Cupo** que gasta el refresco en segundo plano: hay que medirlo y ajustar el intervalo.
- **Luz baja**: el seguimiento empeora. El indicador de «mano detectada» ayuda a entender qué pasa.
- **Conflicto con el trabajo de rendimiento** (diseño `2026-10-25-jarvis-rendimiento-design.md`, en paralelo): los dos pueden tocar `src/agent-options.js`. La query de refresco debería armar sus propias opciones mínimas en lugar de reutilizar las de la conversación.
