#!/usr/bin/env bash
#
# Pre-flatten a JSON-LD dataset so the browser can skip the expensive
# jsonld.flatten() step at load time.
#
# Usage:
#   ./data/flatten.sh <input.jsonld> [output.json]
#
# If no output path is given the result is written next to the input file
# with a "-flat.json" suffix (e.g. esco.jsonld → esco-flat.json).
#
# The script prints progress information to stderr so you can monitor
# long-running jobs.

set -euo pipefail

# ── Helpers ────────────────────────────────────────────────────────────

format_bytes() {
  local bytes=$1
  if (( bytes < 1024 )); then
    echo "${bytes} B"
  elif (( bytes < 1024 * 1024 )); then
    awk "BEGIN { printf \"%.1f KB\", $bytes / 1024 }"
  elif (( bytes < 1024 * 1024 * 1024 )); then
    awk "BEGIN { printf \"%.1f MB\", $bytes / (1024 * 1024) }"
  else
    awk "BEGIN { printf \"%.2f GB\", $bytes / (1024 * 1024 * 1024) }"
  fi
}

elapsed() {
  local start=$1
  local now
  now=$(date +%s)
  local diff=$(( now - start ))
  if (( diff < 60 )); then
    echo "${diff}s"
  else
    local mins=$(( diff / 60 ))
    local secs=$(( diff % 60 ))
    echo "${mins}m ${secs}s"
  fi
}

log() {
  echo "$1" >&2
}

# ── Arguments ─────────────────────────────────────────────────────────

INPUT_PATH="${1:-}"

if [[ -z "$INPUT_PATH" ]]; then
  log "Usage: ./data/flatten.sh <input.jsonld> [output.json]"
  log ""
  log "Pre-flattens a JSON-LD file so the browser can load it instantly."
  exit 1
fi

INPUT_PATH="$(cd "$(dirname "$INPUT_PATH")" && pwd)/$(basename "$INPUT_PATH")"

if [[ -n "${2:-}" ]]; then
  OUTPUT_PATH="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
else
  INPUT_DIR="$(dirname "$INPUT_PATH")"
  INPUT_BASE="$(basename "$INPUT_PATH")"
  INPUT_NAME="${INPUT_BASE%.*}"
  OUTPUT_PATH="${INPUT_DIR}/${INPUT_NAME}-flat.json"
fi

# ── Check prerequisites ──────────────────────────────────────────────

if ! command -v node &> /dev/null; then
  log "❌  node is required but not found in PATH."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -d "$SCRIPT_DIR/node_modules/jsonld" ]]; then
  log "❌  jsonld package not found. Run 'npm install' first."
  exit 1
fi

if [[ ! -f "$INPUT_PATH" ]]; then
  log "❌  Input file not found: $INPUT_PATH"
  exit 1
fi

# ── 1. Read ──────────────────────────────────────────────────────────

log ""
log "📂  Input:  $INPUT_PATH"
log "📄  Output: $OUTPUT_PATH"
log ""

T0=$(date +%s)
log "⏳  Reading input file..."

INPUT_SIZE=$(wc -c < "$INPUT_PATH")
log "    File size: $(format_bytes "$INPUT_SIZE")"
log "✅  File read in $(elapsed $T0)"

# ── 2. Flatten JSON-LD ───────────────────────────────────────────────

T2=$(date +%s)
log ""
log "⏳  Flattening JSON-LD (this is the slow step)..."

# Start a heartbeat in the background
(
  while true; do
    sleep 5
    log "    … still flattening — elapsed $(elapsed $T2)"
  done
) &
HEARTBEAT_PID=$!

# Ensure heartbeat is killed on exit
trap 'kill $HEARTBEAT_PID 2>/dev/null; exit' EXIT INT TERM

# Run the actual flatten via node (jsonld library is required)
FLAT_COUNT=$(node -e "
  import { readFile, writeFile } from 'node:fs/promises';
  import jsonld from 'jsonld';

  const raw = await readFile('$INPUT_PATH', 'utf-8');
  const parsed = JSON.parse(raw);
  const flattened = await jsonld.flatten(parsed);
  const count = Array.isArray(flattened) ? flattened.length : 0;

  await writeFile('$OUTPUT_PATH', JSON.stringify(flattened), 'utf-8');
  console.log(count);
" 2>&1) || {
  kill $HEARTBEAT_PID 2>/dev/null
  trap - EXIT INT TERM
  log ""
  log "❌  jsonld.flatten() failed after $(elapsed $T2)"
  log "    $FLAT_COUNT"
  exit 1
}

kill $HEARTBEAT_PID 2>/dev/null
trap - EXIT INT TERM

log "✅  Flattened in $(elapsed $T2) — ${FLAT_COUNT} entities in the flat graph"

# ── 3. Report output ─────────────────────────────────────────────────

OUTPUT_SIZE=$(wc -c < "$OUTPUT_PATH")

log ""
log "🎉  All done in $(elapsed $T0)"
log "    Input:  $(format_bytes "$INPUT_SIZE") → Output: $(format_bytes "$OUTPUT_SIZE")"
log "    Entities: ${FLAT_COUNT}"
log ""
log "Load the output file directly in the app to skip the flatten step."
log ""
