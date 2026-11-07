#!/usr/bin/env bash
# Generate the TypeScript client from the backend's schema — the one
# definition of how it is done. `npm run build` in client/ and frontend/,
# `cargo xtask client` and CI all run this script.
#
# 1. Finds the backend on the port synapse.config.json's `url` names. If
#    nothing answers there, builds the backend and starts it, and stops it
#    again when done.
# 2. Runs `synapse-cc build` inside the plexus-codegen image against it:
#    the schema is read, the client generated into client/generated/, its
#    dependencies installed, compiled and smoke-tested — in the container,
#    so the host needs only Docker, not synapse, synapse-cc or service-codegen.
#
#   PLEXUS_CODEGEN_IMAGE   the image (default plexus-codegen:latest; a name
#                          with a registry in it is pulled when missing)
#   CARGO_TARGET_DIR       honoured when locating the built backend
#
# Extra arguments go to `synapse-cc build` (e.g. --no-tests, --force).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
image="${PLEXUS_CODEGEN_IMAGE:-plexus-codegen:latest}"
config="$root/synapse.config.json"

say() { printf 'codegen: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

url="$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$config" | head -n1)"
[ -n "$url" ] || die "no \"url\" in $config"
hostport="${url#*://}"; hostport="${hostport%%/*}"
host="${hostport%:*}"; port="${hostport##*:}"
case "$host" in 127.0.0.1|localhost) ;; *) die "$config names $host; this script starts and reaches a local backend only" ;; esac

# --- the image -----------------------------------------------------------
command -v docker >/dev/null || die "docker is not installed — codegen runs in a container"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  if [[ "$image" == */* ]] && docker pull "$image" >&2; then :; else
    die "image $image not found. Build it from the hypermemetic checkouts:
    <workspace>/dockerfiles/plexus-codegen/build.sh
  or point PLEXUS_CODEGEN_IMAGE at one you have."
  fi
fi

# --- the backend ---------------------------------------------------------
answers() { (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; }
if answers; then
  say "using the backend already listening on :$port"
else
  say "building and starting the backend on :$port"
  cargo build --quiet --manifest-path "$root/Cargo.toml" --package my-service-backend
  bin="${CARGO_TARGET_DIR:-$root/target}/debug/my-service"
  log="$(mktemp)"
  PLEXUS_NO_REGISTRY=1 "$bin" --port "$port" --no-shell >"$log" 2>&1 &
  pid=$!
  trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -f "$log"' EXIT
  for _ in $(seq 1 100); do
    answers && break
    kill -0 "$pid" 2>/dev/null || { cat "$log" >&2; die "the backend exited before it listened"; }
    sleep 0.1
  done
  answers || { cat "$log" >&2; die "the backend did not listen on :$port"; }
fi

# --- the generator --------------------------------------------------------
# synapse-cc runs service-codegen inside the image. An image built before
# the generator's rename (NAMING-10, service-codegen 0.5.1) carries it under
# its old name only; either will do until NAMING-18 drops the old one.
docker run --rm "$image" sh -c 'command -v service-codegen || command -v hub-codegen' >/dev/null \
  || die "image $image has no service-codegen — rebuild it: <workspace>/dockerfiles/plexus-codegen/build.sh"

# --- generate ------------------------------------------------------------
# --network host: the container reaches the backend on the host's
# loopback. --user: what it writes is yours. label=disable: on an
# SELinux host (Fedora, Bazzite) a bind mount is unreadable to the
# container otherwise; this turns off labelling for this one container
# rather than relabelling the checkout (:z).
say "synapse-cc build (in $image)"
docker run --rm --network host \
  --security-opt label=disable \
  --user "$(id -u):$(id -g)" \
  -v "$root:/work" -w /work \
  "$image" synapse-cc build "$@"
