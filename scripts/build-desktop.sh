#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -m)" != "arm64" || "$(uname -s)" != "Darwin" ]]; then
  echo 'This build targets Apple Silicon Macs.'
  exit 1
fi
if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent 22.21.1 >/dev/null
fi
uv sync --frozen --extra desktop
(cd frontend && npm ci --no-audit --no-fund && npm run build)
.venv/bin/python -m PyInstaller --noconfirm --clean desktop/SlideExplain.spec
echo 'Ready: dist/Slide Explain.app — drag it to Applications or double-click it here.'
