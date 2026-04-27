#!/usr/bin/env bash
# scripts/backup.sh — back up Mnemosyne canonical state.
#
# Archives:
#   - short/  (canonical short-layer markdown — the source of truth)
#   - long/   (canonical long-layer markdown — the source of truth)
#   - memories/ (legacy; included if present)
#   - config.json (if present)
#   - *.log files
#
# DOES NOT archive chroma-data/ or neo4j-data/ — those are derivable from
# markdown via scripts/rebuild-indexes.ts and would bloat the archive.
#
# Usage:
#   ./scripts/backup.sh                      # default output path
#   ./scripts/backup.sh --output /tmp/x.tgz  # custom path

set -euo pipefail

DATA_DIR="${HOME}/.jarvis/mnemosyne"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEFAULT_OUTPUT="${DATA_DIR}/backups/mnemosyne-${TIMESTAMP}.tar.gz"
OUTPUT="$DEFAULT_OUTPUT"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '1,16p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$DATA_DIR" ]]; then
  echo "ERROR: data dir does not exist: $DATA_DIR" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"

# Build the include list from items that actually exist.
INCLUDES=()
[[ -d "${DATA_DIR}/short" ]] && INCLUDES+=("short")
[[ -d "${DATA_DIR}/long" ]] && INCLUDES+=("long")
[[ -d "${DATA_DIR}/memories" ]] && INCLUDES+=("memories")
[[ -f "${DATA_DIR}/config.json" ]] && INCLUDES+=("config.json")

# Collect *.log at top level (no globstar required, no shell error if none).
shopt -s nullglob
for f in "${DATA_DIR}"/*.log; do
  INCLUDES+=("$(basename "$f")")
done
shopt -u nullglob

if [[ "${#INCLUDES[@]}" -eq 0 ]]; then
  echo "ERROR: nothing to back up under $DATA_DIR (no short/, long/, memories/, config.json, or *.log)" >&2
  exit 1
fi

echo "Backing up Mnemosyne state from: $DATA_DIR"
echo "Including:"
for item in "${INCLUDES[@]}"; do
  echo "  - $item"
done
echo "Excluding: chroma-data/, neo4j-data/, backups/"
echo "Output: $OUTPUT"
echo

# Use tar -C to keep paths relative to DATA_DIR (no leading ~/.jarvis prefix).
tar -czf "$OUTPUT" -C "$DATA_DIR" "${INCLUDES[@]}"

# Verify integrity by listing the archive.
echo "Verifying archive…"
if tar -tzf "$OUTPUT" >/dev/null; then
  echo "Archive verified."
else
  echo "ERROR: archive integrity check failed" >&2
  exit 1
fi

# Final size + path.
size=$(du -h "$OUTPUT" | awk '{print $1}')
echo
echo "Backup created:"
echo "  path: $OUTPUT"
echo "  size: $size"
echo
echo "To restore: ./scripts/restore.sh $OUTPUT"
