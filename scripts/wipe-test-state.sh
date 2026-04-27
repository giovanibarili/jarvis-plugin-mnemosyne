#!/usr/bin/env bash
# scripts/wipe-test-state.sh — DESTRUCTIVE. Use in dev/testing only.
#
# Wipes derived Mnemosyne state so the plugin can boot fresh:
#   - stops the mnemosyne-neo4j container
#   - removes ~/.jarvis/mnemosyne/chroma-data/
#   - removes ~/.jarvis/mnemosyne/neo4j-data/
#
# With --all, ALSO removes ~/.jarvis/mnemosyne/memories/ (the canonical
# source of truth — this is unrecoverable without a backup).
#
# Usage:
#   ./scripts/wipe-test-state.sh         # derived only
#   ./scripts/wipe-test-state.sh --all   # derived + memories
#   ./scripts/wipe-test-state.sh --yes   # skip countdown

set -euo pipefail

RED=$'\033[0;31m'
YELLOW=$'\033[0;33m'
RESET=$'\033[0m'

DATA_DIR="${HOME}/.jarvis/mnemosyne"
CONTAINER_NAME="mnemosyne-neo4j"

WIPE_ALL=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      WIPE_ALL=1
      shift
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    -h|--help)
      sed -n '1,17p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

echo
printf "%s⚠  DANGER  ⚠%s  This script will DELETE Mnemosyne state.\n" "$RED" "$RESET"
echo
echo "Will remove:"
echo "  - container: $CONTAINER_NAME (if running)"
echo "  - $DATA_DIR/chroma-data/"
echo "  - $DATA_DIR/neo4j-data/"
if [[ "$WIPE_ALL" -eq 1 ]]; then
  printf "%s  - %s/{short,long,memories}/   (CANONICAL SOURCE OF TRUTH)%s\n" \
    "$RED" "$DATA_DIR" "$RESET"
fi
echo

if [[ "$ASSUME_YES" -ne 1 ]]; then
  printf "%sStarting in 3 seconds. Press Ctrl-C to abort…%s\n" "$YELLOW" "$RESET"
  for n in 3 2 1; do
    printf "  %d…\n" "$n"
    sleep 1
  done
  echo
fi

# --- stop neo4j container (best effort) --------------------------------------
if command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"; then
    echo "Stopping container $CONTAINER_NAME…"
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"; then
    echo "Removing container $CONTAINER_NAME…"
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
else
  echo "docker not found, skipping container stop"
fi

# --- remove derived dirs -----------------------------------------------------
for sub in chroma-data neo4j-data; do
  target="$DATA_DIR/$sub"
  if [[ -d "$target" ]]; then
    echo "Removing $target …"
    rm -rf "$target"
  else
    echo "Skip $target (not present)"
  fi
done

# --- remove canonical state if --all -----------------------------------------
if [[ "$WIPE_ALL" -eq 1 ]]; then
  for sub in short long memories; do
    target="$DATA_DIR/$sub"
    if [[ -d "$target" ]]; then
      echo "Removing $target … (canonical state)"
      rm -rf "$target"
    else
      echo "Skip $target (not present)"
    fi
  done
fi

echo
echo "Done. JARVIS will rebuild required dirs on next boot."
