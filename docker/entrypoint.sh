#!/usr/bin/env bash
# Prepares the bind-mounted workspace, then hands off to the requested command.
# Everything here is idempotent: the long-lived container path
# (docker compose up -d) re-runs it only on restart.
set -euo pipefail

cd /workspace

# The node_modules volumes start empty on the first run of a fresh volume.
if [ ! -d node_modules/.pnpm ]; then
  echo "==> pnpm install (first run in this volume)"
  pnpm install --frozen-lockfile
fi

# bin/run.js loads dist/, so there has to be a build. A dist/ built on the host
# is reused as-is; run `pnpm build` yourself to pick up source changes.
if [ ! -d apps/cli/dist ]; then
  echo "==> pnpm build"
  pnpm build
fi

# Put `ops` on PATH the same way `pnpm link:global` does on the host.
mkdir -p "$HOME/.local/bin"
ln -sf /workspace/apps/cli/bin/run.js "$HOME/.local/bin/ops"

exec "$@"
