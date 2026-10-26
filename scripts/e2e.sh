#!/usr/bin/env bash
# Prueba de punta a punta de ALTER (subagentes y tareas en segundo plano), en Git Bash.
# Levanta el servidor en el puerto 7788, escucha /api/events y manda tres mensajes por POST.
# Seguridad: toda confirmación se rechaza (allow:false); nunca se acepta ninguna.
# Salida: eventos sin deltas, texto armado por caso y tiempos. Log del servidor en $OUT/server.log.

set -u
cd "$(dirname "$0")/.."
PORT=7788
BASE="http://127.0.0.1:$PORT"
OUT="${E2E_OUT:-$(mktemp -d)}"
EVENTS="$OUT/events.log"
SERVER_LOG="$OUT/server.log"
: > "$EVENTS"

echo "AVISO: este script consume cupo de tu suscripción de Claude y puede abrir pestañas del navegador."
echo "Todas las confirmaciones se rechazan. Salida en: $OUT"

PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

ALTER_PORT=$PORT node server.js > "$SERVER_LOG" 2>&1 &
PIDS+=($!)

# Espera a que el servidor responda y saca el token de la página
TOKEN=""
for _ in $(seq 1 50); do
  TOKEN=$(curl -s "$BASE/" | sed -n 's/.*name="alter-token" content="\([^"]*\)".*/\1/p')
  [ -n "$TOKEN" ] && break
  sleep 0.2
done
[ -n "$TOKEN" ] || { echo "No arrancó el servidor"; cat "$SERVER_LOG"; exit 1; }

curl -s -N -H "x-alter-token: $TOKEN" "$BASE/api/events" >> "$EVENTS" &
PIDS+=($!)

post() { # post RUTA JSON
  curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-alter-token: $TOKEN" \
    -H 'Content-Type: application/json' -d "$2" "$BASE/api/$1"
}

# Rechaza cada `confirm` apenas aparece en el canal
(
  seen=0
  while true; do
    n=$(grep -c '^event: confirm' "$EVENTS")
    while [ "$seen" -lt "$n" ]; do
      seen=$((seen + 1))
      id=$(grep -A1 '^event: confirm' "$EVENTS" | grep '^data:' | sed -n "${seen}p" | sed -n 's/.*"id":"\{0,1\}\([^",}]*\).*/\1/p')
      code=$(post confirm "{\"id\":\"$id\",\"allow\":false}")
      echo "[DENEGADO] confirm id=$id (HTTP $code)" | tee -a "$OUT/denied.log"
    done
    sleep 0.3
  done
) &
PIDS+=($!)

count() { grep -c "^event: $1" "$EVENTS"; }

# Corta todo si el servidor llegó a permitir un envío (no debería pasar nunca)
guard() {
  if grep -qE 'CONFIRMADO|AUTOM.TICO\].*(send|reply|forward)' "$SERVER_LOG"; then
    echo "BLOQUEADO: el servidor permitió un envío"; grep -E 'CONFIRMADO|AUTOM.TICO' "$SERVER_LOG"; exit 2
  fi
}

# caso NOMBRE TEXTO DONES_ESPERADOS TIMEOUT_S
caso() {
  local name=$1 text=$2 dones=$3 limit=$4
  local from d0 t0 tfirst="" now
  from=$(wc -l < "$EVENTS"); d0=$(count done)
  local dl0; dl0=$(count delta)
  t0=$(date +%s%N)
  echo; echo "=== $name: $text"
  post message "{\"text\":\"$text\"}" > /dev/null
  while :; do
    guard
    now=$(date +%s%N)
    [ -z "$tfirst" ] && [ "$(count delta)" -gt "$dl0" ] && tfirst=$(( (now - t0) / 1000000 ))
    [ "$(count done)" -ge $((d0 + dones)) ] && break
    [ $(( (now - t0) / 1000000000 )) -ge "$limit" ] && { echo "TIMEOUT tras ${limit}s"; break; }
    sleep 0.3
  done
  echo "tiempo hasta el primer delta: ${tfirst:-sin delta} ms; total: $(( ($(date +%s%N) - t0) / 1000000 )) ms"
  # Eventos sin deltas y texto armado
  tail -n +"$((from + 1))" "$EVENTS" | grep -v '^event: delta' | grep -vE '^(: ping)?$' | grep -A1 '^event:' | grep -v '^--$' | paste - - 
  echo "--- texto armado:"
  tail -n +"$((from + 1))" "$EVENTS" | grep -A1 '^event: delta' | grep '^data:' |
    node -e 'let s="";require("readline").createInterface({input:process.stdin}).on("line",l=>{s+=JSON.parse(l.slice(5)).text}).on("close",()=>console.log(s))'
}

# Con argumentos: cada uno es un mensaje extra (p. ej. forzar un subagente); sin argumentos, los tres casos base
if [ $# -gt 0 ]; then
  n=0; for msg in "$@"; do n=$((n + 1)); caso "extra $n" "$msg" 1 150; done
  t=0; until [ "$(count done)" -ge $((n + 1)) ] || [ $t -ge 120 ]; do guard; sleep 1; t=$((t + 1)); done
  grep -E "^event: (task|turn)" -A1 "$EVENTS" | grep -v "^--$" | paste - - | tail -10
else
  caso "1 investigacion en segundo plano" "Investigá quién ganó el último mundial" 1 90
  echo "(esperando hasta 180 s la tarea y el turno que sigue)"
  t=0; until [ "$(count done)" -ge 2 ] || [ $t -ge 180 ]; do guard; sleep 1; t=$((t + 1)); done
  echo "--- tras la espera (${t}s):"; grep -E '^event: (task|turn)' -A1 "$EVENTS" | grep -v '^--$' | paste - - | tail -8
  caso "2 correo (envio a test@example.com)" "Pedile al agente de correo que le mande un mail a test@example.com diciendo hola" 1 150
  caso "3 calendario" "¿Qué tengo mañana en el calendario?" 1 120
fi

echo; echo "=== Confirmaciones denegadas:"; cat "$OUT/denied.log" 2>/dev/null || echo "ninguna"
echo "=== Herramientas en el log del servidor:"; grep -E '\[(AUTOM|CONFIRM|RECHAZ)' "$SERVER_LOG"
