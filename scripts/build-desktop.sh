#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -m)" != "arm64" || "$(uname -s)" != "Darwin" ]]; then
  echo 'Build on an Apple Silicon Mac (macOS / arm64).'
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/'
  exit 1
fi
if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent 22.21.1 >/dev/null || { echo 'Run: nvm install 22.21.1'; exit 1; }
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'Install Node 22.21.1 or a newer Node 22, including npm.'
  exit 1
fi
node -e 'const [major,minor,patch]=process.versions.node.split(".").map(Number); if(major!==22 || minor<21 || (minor===21&&patch<1)){console.error("Node 22.21.1 or newer Node 22 required. See README.md.");process.exit(1)}'
uv sync --frozen --extra desktop
(cd frontend && npm ci --no-audit --no-fund && npm run build)
.venv/bin/python -m PyInstaller --noconfirm --clean desktop/SlideExplain.spec
codesign --verify --deep --strict 'dist/Slide Explain.app'
echo 'Ready: dist/Slide Explain.app — drag it to Applications or double-click it here.'
