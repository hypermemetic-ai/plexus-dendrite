#!/usr/bin/env bash
# The service alone serves the app: the frontend's build (frontend/dist, made by
# the frontend layer's step before this one) compiled into the binary with
# `--features embedded-app`, run on free ports, and asked over HTTP for its
# entrypoint — stamped with the WebSocket's port — and every file the
# entrypoint names; then the WebSocket, which admits the shell's origin and
# refuses another. Then again as behind a reverse proxy: --public-url stamps
# the socket's full URL, and the WebSocket admits that origin at /ws.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
say() { printf 'embedded: %s\n' "$*" >&2; }
die() { say "FAIL — $*"; [ -z "${log:-}" ] || cat "$log" >&2; exit 1; }

[ -f frontend/dist/index.html ] || die "no frontend/dist/index.html — the frontend's build runs first"

say "cargo build --features embedded-app"
cargo build --quiet --package my-service-backend --features embedded-app
bin="${CARGO_TARGET_DIR:-$root/target}/debug/my-service"

free() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 1 || return 0; }
# Ports below Linux's ephemeral range (32768–60999): a port an outgoing
# connection holds there answers no connect, so it looks free and still
# cannot be bound. A bind that loses a race anyway is retried on new ports.
log="$(mktemp)"
pid=
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -f "$log"' EXIT
launch() {  # ARGS… — the binary on free ports ($ws, $shell = $ws + 1)
  for attempt in 1 2 3 4 5; do
    for _ in $(seq 1 50); do
      ws=$(( 20000 + RANDOM % 12000 )); shell=$((ws + 1))
      free "$ws" && free "$shell" && break
    done
    PLEXUS_NO_REGISTRY=1 "$bin" --port "$ws" --shell-port "$shell" "$@" >"$log" 2>&1 &
    pid=$!
    for _ in $(seq 1 100); do
      free "$ws" || break
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$pid" 2>/dev/null && break
    grep -q "Address already in use" "$log" || { cat "$log" >&2; die "the backend exited"; }
    say "ports $ws/$shell were taken (attempt $attempt); trying others"
  done
  kill -0 "$pid" 2>/dev/null || { cat "$log" >&2; die "the backend exited"; }
  free "$ws" && die "the backend did not listen on :$ws"
  for _ in $(seq 1 50); do free "$shell" || break; sleep 0.1; done
}
stop() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; pid=; }
launch
grep -q 'Embedded(' "$log" || die "the shell is not serving the embedded build"
base="http://127.0.0.1:$shell"
page="$(curl -fsS "$base/")" || die "GET / failed"
grep -q "content=\"$ws\"" <<<"$page" || die "GET / is not stamped with the WebSocket's port $ws"
grep -q '{{WS_PORT}}' <<<"$page" && die "GET / still holds {{WS_PORT}}"
grep -q '{{WS_URL}}' <<<"$page" && die "GET / still holds {{WS_URL}}"
grep -q 'name="plexus-ws-url" content=""' <<<"$page" || die "GET / has no plexus-ws-url meta, stamped empty (no --public-url)"
say "GET / 200, stamped with :$ws (and no socket URL)"

# Every local script, stylesheet and module the entrypoint names.
assets="$(grep -oE '(src|href)="/[^"]+"' <<<"$page" | sed -E 's/^(src|href)="//; s/"$//' | sort -u)"
[ -n "$assets" ] || die "the entrypoint names no assets"
for a in $assets; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$base$a")"
  [ "$code" = 200 ] || die "GET $a: $code"
  say "GET $a 200"
done
code="$(curl -sS -o /dev/null -w '%{http_code}' "$base/no/such/asset.js")"
[ "$code" = 404 ] || die "GET a missing asset: $code, not 404"

upgrade() {  # ORIGIN [PATH] → the WebSocket upgrade's status
  curl -sS -o /dev/null -w '%{http_code}' --max-time 3 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: $1" "http://127.0.0.1:$ws${2:-/}" 2>/dev/null || true
}
[ "$(upgrade "$base")" = 101 ] || die "the WebSocket refused the shell's origin $base"
[ "$(upgrade http://evil.example)" = 403 ] || die "the WebSocket admitted a foreign origin"
say "the WebSocket admits $base and refuses another origin"
stop

# Behind a reverse proxy (layer host's edge): --public-url stamps the
# socket's full URL, at the public origin's /ws, and the WebSocket admits
# that origin — at /ws too, the path the proxy forwards as it is.
public=https://ci-public.example
launch --public-url "$public/" --behind-proxy
page="$(curl -fsS "http://127.0.0.1:$shell/")" || die "GET / (--public-url) failed"
grep -q 'name="plexus-ws-url" content="wss://ci-public.example/ws"' <<<"$page" \
  || die "GET / with --public-url $public is not stamped with wss://ci-public.example/ws"
[ "$(upgrade "$public" /ws)" = 101 ] || die "the WebSocket refused the public origin $public at /ws"
[ "$(upgrade http://evil.example /ws)" = 403 ] || die "the WebSocket admitted a foreign origin at /ws"
say "--public-url $public: stamped wss://ci-public.example/ws; /ws admits $public, refuses another"
stop
say "ok"
