#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/build-desktop.sh
release_version=$(.venv/bin/python -c 'import pathlib,tomllib; print(tomllib.loads(pathlib.Path("pyproject.toml").read_text())["project"]["version"])')
release_check_dir=$(mktemp -d "${TMPDIR:-/tmp}/slide-explain-release.XXXXXX")
trap 'rm -rf "$release_check_dir"' EXIT
SLIDE_EXPLAIN_DATA_DIR="$release_check_dir" 'dist/Slide Explain.app/Contents/MacOS/Slide Explain' --check
release_zip="Slide-Explain-${release_version}-macos-arm64.zip"
# Keep the native bundle structure, executable permissions and macOS metadata.
ditto -c -k --sequesterRsrc --keepParent 'dist/Slide Explain.app' "dist/$release_zip"
(cd dist && shasum -a 256 "$release_zip" > SHA256SUMS.txt)
echo "Release assets: dist/$release_zip and dist/SHA256SUMS.txt"
