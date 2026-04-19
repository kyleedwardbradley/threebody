#!/usr/bin/env bash
# Installed as a conda activate.d hook. Runs `npm install` only when
# package.json / package-lock.json is newer than node_modules/.package-lock.json.
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="$PROJECT_DIR/node_modules/.package-lock.json"

needs_install=0
if [ ! -d "$PROJECT_DIR/node_modules" ] || [ ! -f "$MARKER" ]; then
  needs_install=1
else
  for f in "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json"; do
    [ -f "$f" ] && [ "$f" -nt "$MARKER" ] && needs_install=1
  done
fi

if [ "$needs_install" = "1" ]; then
  echo "[threebody] running npm install…"
  ( cd "$PROJECT_DIR" && npm install )
fi
