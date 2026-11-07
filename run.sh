#!/usr/bin/env bash
# The "Grow" chapter of PLEXUS-40's film, for real (VISION-4).
#
#   ./run.sh           build, start, play the film's command, stop
#   ./run.sh up        build and start; leave them running (.run/ has pids and logs)
#   ./run.sh film      the film's command, against what `up` started
#   ./run.sh proof     edit index.ts (rain > 0.5 → rain > 1.5), restart the
#                      dendrite, ask again, put index.ts back, restart, ask again
#   ./run.sh down      stop what `up` started
#
# What runs, all on loopback:
#   registry    plexus-registry on $REGISTRY_PORT (4600): every service below
#               announces itself to it (PLEXUS_REGISTRY_URL), and synapse finds
#               `my-service` by name through it
#   weather     examples/weather on 4601: weather-service, `weather.forecast`
#   my-service  examples/my-service (made by plexus-starter) on 4610, mounting
#               the dendrite with --child digest=stdio:bin/plexus-dendrite serve
#               dendrites/digest --target weather=ws://127.0.0.1:4601
#
# REGISTRY_PORT=4444 ./run.sh   puts the registry on synapse's default port,
# so the film's bare `synapse my-service digest do_thing --city lisbon` resolves.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
ws="$(cd "$root/.." && pwd)"
run="$root/.run"
REGISTRY_PORT="${REGISTRY_PORT:-4600}"
WEATHER_PORT="${WEATHER_PORT:-4601}"
MY_PORT="${MY_SERVICE_PORT:-4610}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/target}"
REGISTRY_SRC="${PLEXUS_REGISTRY_SRC:-$ws/plexus-registry}"
mkdir -p "$run"

say() { printf '\033[2m# %s\033[0m\n' "$*" >&2; }
die() { printf 'run.sh: %s\n' "$*" >&2; exit 1; }
answers() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_port() {
  local port=$1 pid=$2 name=$3
  for _ in $(seq 1 300); do
    answers "$port" && return 0
    kill -0 "$pid" 2>/dev/null || { tail -n 30 "$run/$name.log" >&2; die "$name exited before it listened on :$port"; }
    sleep 0.1
  done
  tail -n 30 "$run/$name.log" >&2
  die "$name did not listen on :$port"
}

synapse_reg() {
  # `-P PORT` is synapse's registry/discovery port: with no PORT it is 4444.
  if [ "$REGISTRY_PORT" = 4444 ]; then synapse "$@"; else synapse -P "$REGISTRY_PORT" "$@"; fi
}

build() {
  command -v synapse >/dev/null || die "synapse is not on PATH"
  command -v node >/dev/null || die "node (>= 22) is not on PATH"
  [ -d "$root/node_modules/tsx" ] || (say "npm ci"; cd "$root" && npm ci --no-audit --no-fund >&2)
  say "cargo build: weather, my-service, plexus-registry"
  cargo build --quiet --manifest-path "$root/examples/weather/Cargo.toml"
  cargo build --quiet --manifest-path "$root/examples/my-service/Cargo.toml" -p my-service-backend
  [ -f "$REGISTRY_SRC/Cargo.toml" ] || die "no plexus-registry checkout at $REGISTRY_SRC (PLEXUS_REGISTRY_SRC)"
  cargo build --quiet --manifest-path "$REGISTRY_SRC/Cargo.toml"
}

start() {
  [ -f "$run/pids" ] && die "already up ($run/pids) — ./run.sh down first"
  for p in "$REGISTRY_PORT" "$WEATHER_PORT" "$MY_PORT"; do answers "$p" && die ":$p is taken"; done
  : > "$run/pids"
  : > "$run/backends.toml"
  rm -f "$run/registry.db"
  say "registry on :$REGISTRY_PORT"
  RUST_LOG=warn "$CARGO_TARGET_DIR/debug/plexus-registry" --port "$REGISTRY_PORT" --host 127.0.0.1 \
    --db-path "$run/registry.db" --config "$run/backends.toml" >"$run/registry.log" 2>&1 &
  echo "registry $!" >> "$run/pids"
  wait_port "$REGISTRY_PORT" $! registry

  export PLEXUS_REGISTRY_URL="ws://127.0.0.1:$REGISTRY_PORT"
  say "weather-service on :$WEATHER_PORT${WEATHER_LIVE:+ (live)}"
  "$CARGO_TARGET_DIR/debug/weather" --port "$WEATHER_PORT" ${WEATHER_LIVE:+--live} >"$run/weather.log" 2>&1 &
  echo "weather $!" >> "$run/pids"
  wait_port "$WEATHER_PORT" $! weather

  say "my-service on :$MY_PORT, mounting digest (the dendrite)"
  "$CARGO_TARGET_DIR/debug/my-service" --port "$MY_PORT" --no-shell --child-timeout 60s \
    --child "digest=stdio:$root/bin/plexus-dendrite serve $root/dendrites/digest --target weather=ws://127.0.0.1:$WEATHER_PORT" \
    >"$run/my-service.log" 2>&1 &
  echo "my-service $!" >> "$run/pids"
  wait_port "$MY_PORT" $! my-service
  # the services announce themselves a moment after they listen
  for _ in $(seq 1 50); do grep -q 'my-service' "$run/registry.log" 2>/dev/null && break; sleep 0.1; done
  sleep 0.5
}

stop() {
  [ -f "$run/pids" ] || return 0
  # my-service first: its stdio child (the dendrite) sees EOF and exits with it
  tac "$run/pids" | while read -r name pid; do
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  done
  for _ in $(seq 1 50); do
    alive=0
    while read -r _ pid; do kill -0 "$pid" 2>/dev/null && alive=1; done < "$run/pids"
    [ "$alive" = 0 ] && break
    sleep 0.1
  done
  rm -f "$run/pids"
}

ask() {
  # the film's command: `synapse my-service digest do_thing --city lisbon`
  local out="$run/answer.txt"
  if [ "$REGISTRY_PORT" = 4444 ]; then
    printf '\n$ synapse my-service digest do_thing --city %s\n' "$1"
  else
    printf '\n$ synapse -P %s my-service digest do_thing --city %s\n' "$REGISTRY_PORT" "$1"
  fi
  synapse_reg -o "$out" --reconnect-for 0 my-service digest do_thing --city "$1"
  cat "$out"
}

dendrite_pid() {
  local my
  my="$(awk '$1 == "my-service" { print $2 }' "$run/pids")"
  pgrep -P "$my" | head -n 1
}

restart_dendrite() {
  local pid
  pid="$(dendrite_pid)"
  [ -n "$pid" ] || die "no dendrite under my-service"
  say "restarting the dendrite (pid $pid): my-service starts it again on the next call"
  kill "$pid"
  sleep 1
}

proof() {
  local f="$root/dendrites/digest/index.ts" keep="$run/index.ts.orig"
  cp "$f" "$keep"
  trap 'cp "$keep" "$f"' EXIT
  ask lisbon
  say "edit dendrites/digest/index.ts: rain > 0.5 → rain > 1.5"
  sed -i 's/d.rain > 0.5/d.rain > 1.5/' "$f"
  grep -n 'rain >' "$f" >&2
  restart_dendrite
  ask lisbon
  say "put index.ts back"
  cp "$keep" "$f"
  trap - EXIT
  restart_dendrite
  ask lisbon
}

case "${1:-all}" in
  all)
    build
    trap stop EXIT
    start
    ask lisbon
    ;;
  up) build; start; say "up: ./run.sh film | proof | down (logs in $run)" ;;
  film) ask "${2:-lisbon}" ;;
  proof) proof ;;
  down) stop ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
