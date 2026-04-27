#!/usr/bin/env bash
# scripts/restore.sh — restore Mnemosyne markdown state from a backup archive.
#
# Restores the markdown source of truth (and config / logs). Does NOT rebuild
# Chroma or Neo4j — run scripts/rebuild-indexes.ts after restore.
#
# Before extracting, the current contents of TARGET_DIR are moved into a
# .pre-restore-<timestamp>/ folder so nothing is lost.
#
# Usage:
#   ./scripts/restore.sh <archive-path> [--target DIR] [--yes]
#
# Flags:
#   --target DIR  Override target (default: ~/.jarvis/mnemosyne)
#   --yes         Skip confirmation prompt (for automation)

set -euo pipefail

DEFAULT_TARGET="${HOME}/.jarvis/mnemosyne"
TARGET="$DEFAULT_TARGET"
ARCHIVE=""
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
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
      if [[ -z "$ARCHIVE" ]]; then
        ARCHIVE="$1"
        shift
      else
        echo "Unknown argument: $1" >&2
        exit 2
      fi
      ;;
  esac
done

if [[ -z "$ARCHIVE" ]]; then
  echo "ERROR: archive path required" >&2
  echo "Usage: $0 <archive-path> [--target DIR] [--yes]" >&2
  exit 2
fi

if [[ ! -f "$ARCHIVE" ]]; then
  echo "ERROR: archive does not exist: $ARCHIVE" >&2
  exit 1
fi

# Sanity check archive
echo "Inspecting archive…"
if ! tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
  echo "ERROR: not a valid tar.gz archive: $ARCHIVE" >&2
  exit 1
fi

echo
echo "Restore plan:"
echo "  archive:   $ARCHIVE"
echo "  target:    $TARGET"
echo

if [[ -d "$TARGET" ]] && [[ -n "$(ls -A "$TARGET" 2>/dev/null || true)" ]]; then
  echo "Target directory is NOT empty. Existing contents will be moved to:"
  echo "  $TARGET/.pre-restore-<timestamp>/"
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo
  read -r -p "Proceed with restore? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *)
      echo "Aborted."
      exit 0
      ;;
  esac
fi

mkdir -p "$TARGET"

# Move existing contents (non-pre-restore items only) into a snapshot dir.
shopt -s nullglob dotglob
existing=( "$TARGET"/* )
shopt -u nullglob dotglob

if [[ "${#existing[@]}" -gt 0 ]]; then
  ts=$(date +%Y%m%d-%H%M%S)
  snapshot_dir="$TARGET/.pre-restore-$ts"
  mkdir -p "$snapshot_dir"
  echo "Moving existing contents to $snapshot_dir/ …"
  for item in "${existing[@]}"; do
    base=$(basename "$item")
    # Don't move our own snapshot dir
    [[ "$base" == .pre-restore-* ]] && continue
    mv "$item" "$snapshot_dir/"
  done
fi

echo "Extracting archive into $TARGET …"
tar -xzf "$ARCHIVE" -C "$TARGET"

echo
echo "Restore complete."
echo
echo "Next steps:"
echo "  1. Ensure Chroma + Neo4j are running (e.g. restart JARVIS or run preflight)."
echo "  2. Rebuild derived indexes from markdown:"
echo "     npx tsx scripts/rebuild-indexes.ts"
echo
if [[ -d "$TARGET/.pre-restore-"* 2>/dev/null ]]; then
  echo "Previous state preserved under $TARGET/.pre-restore-* in case you need to roll back."
fi
