#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v uv >/dev/null 2>&1; then
  echo 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/'
  exit 1
fi
if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent 22.21.1 >/dev/null || { echo 'Run: nvm install 22.21.1'; exit 1; }
fi
node -e 'const [major,minor,patch]=process.versions.node.split(".").map(Number); if(major!==22 || minor<21 || (minor===21&&patch<1)){console.error("Node 22.21.1 or newer Node 22 required. See README.md.");process.exit(1)}'
if [[ ! -x .venv/bin/python || ! -f .venv/.slide-notes-ready || uv.lock -nt .venv/.slide-notes-ready || pyproject.toml -nt .venv/.slide-notes-ready ]]; then
  uv sync --frozen
  touch .venv/.slide-notes-ready
fi
if [[ ! -d frontend/node_modules || ! -f frontend/node_modules/.slide-notes-ready || frontend/package-lock.json -nt frontend/node_modules/.slide-notes-ready ]]; then
  (cd frontend && npm ci --no-audit --no-fund)
  touch frontend/node_modules/.slide-notes-ready
fi
if [[ ! -f frontend/dist/index.html ]] || [[ -n "$(find frontend/src frontend/index.html frontend/vite.config.ts frontend/package-lock.json -type f -newer frontend/dist/index.html -print -quit)" ]]; then
  (cd frontend && npm run build)
fi
echo ''
echo 'Slide Explain is starting at http://127.0.0.1:8000'
echo 'Keep this terminal open. Press Ctrl+C to stop.'
exec .venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 --no-access-log
