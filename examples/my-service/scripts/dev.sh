#!/usr/bin/env bash
# The backend and Vite's dev server together (`cargo xtask dev`), until
# either exits or Ctrl-C; then both stop. (Layer ts: replaces base's dev.sh.)
#
# Vite serves the app on http://127.0.0.1:5173 (vite.config.ts) with hot
# reload, and the page talks to the backend's WebSocket on :4610, which
# admits Vite's origin. The backend's shell (:4610 + 1) serves
# frontend/dist too, when it is built. Extra arguments go to the backend.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ -d frontend/node_modules ] || npm --prefix frontend ci
cargo build --package my-service-backend
# The processes themselves (not cargo or npm wrapped round them), so the
# trap stops them.
"${CARGO_TARGET_DIR:-$root/target}/debug/my-service" \
  --allow-origin http://127.0.0.1:5173 --allow-origin http://localhost:5173 "$@" & backend=$!
(cd frontend && exec node_modules/.bin/vite) & frontend=$!
trap 'kill "$backend" "$frontend" 2>/dev/null || true' EXIT INT TERM
wait -n "$backend" "$frontend"
