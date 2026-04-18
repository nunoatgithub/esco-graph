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

set -euo pipefail

log() { echo "$1" >&2; }

INPUT_PATH="${1:-}"

if [[ -z "$INPUT_PATH" ]]; then
  log "Usage: ./data/flatten.sh <input.jsonld> [output.json]"
  log "Pre-flattens a JSON-LD file so the browser can load it instantly."
  exit 1
fi

INPUT_PATH="$(cd "$(dirname "$INPUT_PATH")" && pwd)/$(basename "$INPUT_PATH")"

if [[ -n "${2:-}" ]]; then
  OUTPUT_PATH="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
else
  OUTPUT_PATH="${INPUT_PATH%.*}-flat.json"
fi

# ── Check prerequisites ──────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  log "❌  node is required but not found in PATH."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -d "$SCRIPT_DIR/node_modules/jsonld" || ! -d "$SCRIPT_DIR/node_modules/stream-json" ]]; then
  log "❌  Required packages not found. Run 'npm install' first."
  exit 1
fi

if [[ ! -f "$INPUT_PATH" ]]; then
  log "❌  Input file not found: $INPUT_PATH"
  exit 1
fi

# ── Flatten ───────────────────────────────────────────────────────────

log ""
log "📂  Input:  $INPUT_PATH ($(du -h "$INPUT_PATH" | cut -f1))"
log "📄  Output: $OUTPUT_PATH"
log ""
log "⏳  Flattening JSON-LD..."

SECONDS=0

# Heartbeat so long jobs don't look stuck
while sleep 5; do log "    … still flattening — ${SECONDS}s elapsed"; done &
HEARTBEAT_PID=$!
trap 'kill $HEARTBEAT_PID 2>/dev/null' EXIT

FLAT_COUNT=$(FLATTEN_INPUT="$INPUT_PATH" FLATTEN_OUTPUT="$OUTPUT_PATH" node -e "
  import { createReadStream, createWriteStream } from 'node:fs';
  import { once } from 'node:events';
  import { createRequire } from 'node:module';
  import { dirname, join } from 'node:path';
  import jsonld from 'jsonld';
  import { forceSimulation, forceLink, forceManyBody, forceCenter } from 'd3-force-3d';

  const require = createRequire(import.meta.url);
  const streamJsonDir = dirname(require.resolve('stream-json'));
  const createJsonParser = require('stream-json');
  const Assembler = require(join(streamJsonDir, 'assembler.js'));

  // Stream-parse the input (too large for readFileSync)
  const readJsonFromFile = async (filePath) => {
    const jsonParser = createJsonParser();
    const assembler = Assembler.connectTo(jsonParser);
    const input = createReadStream(filePath);
    input.pipe(jsonParser);
    try {
      await Promise.race([
        once(assembler, 'done'),
        once(input, 'error').then(([e]) => Promise.reject(e)),
        once(jsonParser, 'error').then(([e]) => Promise.reject(e)),
      ]);
      return assembler.current;
    } finally {
      input.destroy();
    }
  };

  const parsed = await readJsonFromFile(process.env.FLATTEN_INPUT);
  const flattened = await jsonld.flatten(parsed);
  const items = Array.isArray(flattened) ? flattened : [];

  // ── Resolve label references ──────────────────────────────────────
  const LABEL_TYPE = 'http://www.w3.org/2008/05/skos-xl#Label';
  const LITERAL_FORM = 'http://www.w3.org/2008/05/skos-xl#literalForm';
  const PREF_LABEL = 'http://www.w3.org/2008/05/skos-xl#prefLabel';
  const ALT_LABEL  = 'http://www.w3.org/2008/05/skos-xl#altLabel';

  // Types that are just metadata — not useful as graph nodes
  const SKIP_TYPES = new Set([
    LABEL_TYPE,
    'http://data.europa.eu/esco/model#AssociationObject',
    'http://data.europa.eu/esco/model#NodeLiteral',
    'http://data.europa.eu/esco/model#Identifier',
    'http://www.w3.org/ns/adms#Identifier',
    'http://data.europa.eu/esco/model#LabelRole',
  ]);

  const shouldSkip = (types) =>
    Array.isArray(types) && types.some((t) => SKIP_TYPES.has(t));

  // 1. Build lookups: label @id → language code, label @id → text (prefer English)
  const labelLangs = new Map();
  const labelTexts = new Map();
  for (const item of items) {
    const types = item['@type'];
    if (!Array.isArray(types) || !types.includes(LABEL_TYPE)) continue;
    const forms = item[LITERAL_FORM];
    if (!Array.isArray(forms)) continue;
    let bestText = null;
    let bestLang = null;
    for (const form of forms) {
      if (form['@language']) {
        if (!bestLang) bestLang = form['@language'];
        labelLangs.set(item['@id'], form['@language']);
      }
      if (form['@value']) {
        if (!bestText || form['@language'] === 'en') {
          bestText = form['@value'];
        }
      }
    }
    if (bestText) labelTexts.set(item['@id'], bestText);
  }

  // 2. Enrich meaningful entities, filter out metadata entities
  const output = [];
  for (const item of items) {
    if (shouldSkip(item['@type'])) continue;

    const langs = new Set();
    for (const key of [PREF_LABEL, ALT_LABEL]) {
      const refs = item[key];
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        const lang = labelLangs.get(ref['@id']);
        if (lang) langs.add(lang);
      }
    }

    if (langs.size > 0) {
      item.languages = [...langs].sort();
    }

    // Resolve preferredLabel — prefer English, fall back to any language
    const prefRefs = item[PREF_LABEL];
    if (Array.isArray(prefRefs)) {
      let fallback = null;
      for (const ref of prefRefs) {
        const lang = labelLangs.get(ref['@id']);
        const text = labelTexts.get(ref['@id']);
        if (text && lang === 'en') { item.preferredLabel = text; fallback = null; break; }
        if (text && !fallback) fallback = text;
      }
      if (fallback) item.preferredLabel = fallback;
    }

    output.push(item);
  }

  // ── Compute 3D layout ──────────────────────────────────────────────
  const RELATION_SUFFIXES = [
    'broader', 'narrower',
    'isessentialskillfor', 'isoptionalskillfor',
    'relatedessentialskill', 'relatedoptionalskill',
  ];

  const entityById = new Map();
  for (const entity of output) {
    entityById.set(entity['@id'], entity);
  }

  const linkSet = new Set();
  const simLinks = [];
  const externalIds = new Set();

  for (const entity of output) {
    const sourceId = entity['@id'];
    for (const [key, value] of Object.entries(entity)) {
      const lower = key.toLowerCase();
      if (!RELATION_SUFFIXES.some((s) => lower.endsWith(s))) continue;
      const targets = Array.isArray(value) ? value : [value];
      for (const t of targets) {
        const targetId = typeof t === 'string' ? t : t?.['@id'];
        if (!targetId) continue;
        if (!entityById.has(targetId)) {
          externalIds.add(targetId);
        }
        const lk = sourceId + '|' + targetId;
        if (linkSet.has(lk)) continue;
        linkSet.add(lk);
        simLinks.push({ source: sourceId, target: targetId });
      }
    }
  }

  // Create minimal entities for external references
  for (const extId of externalIds) {
    const extEntity = { '@id': extId, '@type': ['external'] };
    entityById.set(extId, extEntity);
    output.push(extEntity);
  }

  const simNodes = output.map((e) => ({ id: e['@id'] }));

  process.stderr.write('  Layout: ' + simNodes.length + ' nodes (' + externalIds.size + ' external), ' + simLinks.length + ' links\\n');

  const sim = forceSimulation(simNodes, 3)
    .force('link', forceLink(simLinks).id((d) => d.id).distance(30))
    .force('charge', forceManyBody().strength(-50))
    .force('center', forceCenter())
    .stop();

  const totalTicks = Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()));
  for (let tick = 0; tick < totalTicks; tick++) {
    sim.tick();
    if (tick % 50 === 0) {
      process.stderr.write('  Layout tick ' + tick + '/' + totalTicks + '\\n');
    }
  }
  process.stderr.write('  Layout complete (' + totalTicks + ' ticks)\\n');

  // Write positions back to entities (rounded to reduce JSON size)
  for (const sn of simNodes) {
    const entity = entityById.get(sn.id);
    if (entity) {
      entity.x = Math.round(sn.x * 100) / 100;
      entity.y = Math.round(sn.y * 100) / 100;
      entity.z = Math.round(sn.z * 100) / 100;
    }
  }

  // Stream-write the output (can also exceed string limits)
  const out = createWriteStream(process.env.FLATTEN_OUTPUT, { encoding: 'utf-8' });
  out.write('[');
  for (let i = 0; i < output.length; i++) {
    if (i > 0) out.write(',');
    const ok = out.write(JSON.stringify(output[i]));
    if (!ok) await once(out, 'drain');
  }
  out.write(']');
  out.end();
  await once(out, 'finish');

  const stats = { entities: output.length, external: externalIds.size, labels: labelLangs.size };
  console.log(JSON.stringify(stats));
" 2>&1) || {
  log "❌  Flatten failed after ${SECONDS}s — $FLAT_COUNT"
  exit 1
}

kill $HEARTBEAT_PID 2>/dev/null
trap - EXIT

ENTITIES=$(echo "$FLAT_COUNT" | node -e "const s=require('fs').readFileSync(0,'utf8');const d=JSON.parse(s);console.log(d.entities)" 2>/dev/null || echo "$FLAT_COUNT")
LABELS=$(echo "$FLAT_COUNT" | node -e "const s=require('fs').readFileSync(0,'utf8');const d=JSON.parse(s);console.log(d.labels)" 2>/dev/null || echo "?")

log "✅  Done in ${SECONDS}s"
log "    Entities: ${ENTITIES} (resolved ${LABELS} label nodes)"
log "    Output: $(du -h "$OUTPUT_PATH" | cut -f1)"
log ""
