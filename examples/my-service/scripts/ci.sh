#!/usr/bin/env bash
# Every CI step, locally — what .github/workflows/ runs, in order.
#
# base's step is the backend's tests; each layer adds its own as a file in
# scripts/ci.d/, run here in name order.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

echo "ci: backend — cargo test --workspace"
cargo test --workspace

for step in scripts/ci.d/*.sh; do
  [ -e "$step" ] || continue
  echo "ci: $(basename "$step" .sh)"
  bash "$step"
done

echo "ci: ok"
