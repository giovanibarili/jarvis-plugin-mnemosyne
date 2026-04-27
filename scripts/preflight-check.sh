#!/usr/bin/env bash
# Mnemosyne preflight — standalone bash mirror of lib/preflight.ts
#
# Replicates the same checks performed at plugin boot, but with zero JS
# dependencies. Useful for diagnosing setup issues before installing the
# plugin or after machine changes.
#
# Exit 0 if all green, 1 if any check fails.

set -euo pipefail

GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
YELLOW=$'\033[0;33m'
DIM=$'\033[2m'
RESET=$'\033[0m'

PASS_MARK="✓"
FAIL_MARK="✗"

DATA_DIR="${HOME}/.jarvis/mnemosyne"
PORTS=(7687 7474 8765)
NEO4J_IMAGE="neo4j:5-community"

failures=()

check() {
  local name="$1"
  local status="$2"   # 0=pass, 1=fail
  local detail="${3:-}"
  local action="${4:-}"

  if [[ "$status" -eq 0 ]]; then
    printf "  %s%s%s %-22s %s%s%s\n" \
      "$GREEN" "$PASS_MARK" "$RESET" "$name" "$DIM" "$detail" "$RESET"
  else
    printf "  %s%s%s %-22s %s\n" \
      "$RED" "$FAIL_MARK" "$RESET" "$name" "$detail"
    if [[ -n "$action" ]]; then
      printf "      %s→ %s%s\n" "$YELLOW" "$action" "$RESET"
    fi
    failures+=("$name: $detail")
  fi
}

# --- docker binary -----------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  ver=$(docker --version 2>/dev/null | head -1)
  check "docker" 0 "$ver"

  # docker daemon
  if docker info >/dev/null 2>&1; then
    check "docker-daemon" 0 "running"
  else
    check "docker-daemon" 1 "daemon not responding" \
      "Start Docker Desktop"
  fi
else
  check "docker" 1 "not found in PATH" \
    "Install Docker Desktop: https://docs.docker.com/get-docker/"
  check "docker-daemon" 1 "skipped (no docker)"
fi

# --- python3 -----------------------------------------------------------------
if command -v python3 >/dev/null 2>&1; then
  pyver=$(python3 --version 2>&1 | awk '{print $2}')
  pymaj=$(echo "$pyver" | cut -d. -f1)
  pymin=$(echo "$pyver" | cut -d. -f2)
  if [[ "$pymaj" -gt 3 || ( "$pymaj" -eq 3 && "$pymin" -ge 10 ) ]]; then
    check "python3" 0 "$pyver"
  else
    check "python3" 1 "$pyver too old (need >= 3.10)" \
      "brew install python@3.11"
  fi
else
  check "python3" 1 "not found" "brew install python@3.11"
fi

# --- pip ---------------------------------------------------------------------
if command -v pip3 >/dev/null 2>&1; then
  pipver=$(pip3 --version 2>&1 | awk '{print $2}')
  check "pip3" 0 "$pipver"
elif command -v pip >/dev/null 2>&1; then
  pipver=$(pip --version 2>&1 | awk '{print $2}')
  check "pip" 0 "$pipver"
else
  check "pip" 1 "not found" "python3 -m ensurepip"
fi

# --- chromadb python package -------------------------------------------------
chroma_check_ok=1
if command -v pip3 >/dev/null 2>&1; then
  if pip3 show chromadb >/dev/null 2>&1; then
    chroma_ver=$(pip3 show chromadb 2>/dev/null | awk '/^Version:/ {print $2}')
    check "chromadb" 0 "v$chroma_ver"
    chroma_check_ok=0
  fi
fi
if [[ "$chroma_check_ok" -ne 0 ]]; then
  if command -v chroma >/dev/null 2>&1; then
    check "chromadb" 0 "chroma CLI on PATH"
  else
    check "chromadb" 1 "not installed" "pip install chromadb"
  fi
fi

# --- neo4j image -------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker image inspect "$NEO4J_IMAGE" >/dev/null 2>&1; then
    check "neo4j-image" 0 "$NEO4J_IMAGE present"
  else
    # Image not local; check we could pull it (requires manifest fetch).
    if docker manifest inspect "$NEO4J_IMAGE" >/dev/null 2>&1; then
      check "neo4j-image" 0 "$NEO4J_IMAGE pullable (not yet downloaded)"
    else
      # Manifest inspect can fail without experimental flags; treat as warn.
      check "neo4j-image" 0 "$NEO4J_IMAGE will be pulled on first run"
    fi
  fi
else
  check "neo4j-image" 1 "skipped (no docker)"
fi

# --- ports -------------------------------------------------------------------
# A port being "in use" is only a problem if it's NOT us. Re-running preflight
# on a host where Mnemosyne is already up should pass cleanly.
#   7687 / 7474 → owned by us if mnemosyne-neo4j container is running + 127.0.0.1
#   8765        → owned by us if Chroma heartbeat responds
port_owned_by_us() {
  local port=$1
  case "$port" in
    7687|7474)
      if ! command -v docker >/dev/null 2>&1; then return 1; fi
      local running
      running=$(docker inspect mnemosyne-neo4j --format '{{.State.Running}}' 2>/dev/null || echo "")
      [[ "$running" == "true" ]] || return 1
      docker port mnemosyne-neo4j "$port" 2>/dev/null | grep -q "^127.0.0.1:"
      ;;
    8765)
      curl -fsS --max-time 2 "http://127.0.0.1:$port/api/v2/heartbeat" >/dev/null 2>&1
      ;;
    *) return 1 ;;
  esac
}

for port in "${PORTS[@]}"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    if port_owned_by_us "$port"; then
      check "port-$port" 0 "in use by mnemosyne (ok)"
    else
      proc=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1, "pid="$2}')
      check "port-$port" 1 "in use by another process ($proc)" \
        "Stop the process or change config"
    fi
  else
    check "port-$port" 0 "free"
  fi
done

# --- data dir ----------------------------------------------------------------
if [[ ! -d "$DATA_DIR" ]]; then
  if mkdir -p "$DATA_DIR" 2>/dev/null; then
    check "data-dir" 0 "$DATA_DIR (created)"
  else
    check "data-dir" 1 "cannot create $DATA_DIR" \
      "Check permissions on $(dirname "$DATA_DIR")"
  fi
elif [[ -w "$DATA_DIR" ]]; then
  check "data-dir" 0 "$DATA_DIR (writable)"
else
  check "data-dir" 1 "$DATA_DIR not writable"
fi

# --- summary -----------------------------------------------------------------
echo
if [[ "${#failures[@]}" -eq 0 ]]; then
  printf "%sAll preflight checks passed.%s\n" "$GREEN" "$RESET"
  exit 0
else
  printf "%s%d check(s) failed:%s\n" "$RED" "${#failures[@]}" "$RESET"
  for f in "${failures[@]}"; do
    printf "  - %s\n" "$f"
  done
  exit 1
fi
