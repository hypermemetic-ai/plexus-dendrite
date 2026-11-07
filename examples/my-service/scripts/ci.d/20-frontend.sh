#!/usr/bin/env bash
# Layer ts's CI step: the frontend's build — which builds the client first,
# and the client's build is scripts/codegen.sh (the backend, started if
# nothing answers on its port, and synapse-cc in the plexus-codegen image).
set -euo pipefail
cd "$(dirname "$0")/../../frontend"
npm ci
npm run build
