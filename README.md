# esco-graph

Browser-only React + TypeScript app for interactive ESCO JSON-LD graph visualization in 3D.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Features implemented

- Load ESCO JSON-LD from:
  - bundled sample (`public/sample-esco.jsonld`)
  - local `.json/.jsonld` file
  - URL
- JSON-LD normalization with `jsonld.flatten()` in a **Web Worker**
- Graph transformation module (`src/graph/escoGraph.ts`) to extract and deduplicate:
  - Nodes: `@id`, `@type`, `preferredLabel.en`
  - Links: `broaderSkill`, `relatedSkill`, `hasEssentialSkill`, `hasOptionalSkill`
- `react-force-graph-3d` rendering with:
  - zoom / pan / rotate
  - node dragging
  - force-directed layout
  - hover tooltip (`label + type`)
  - click-to-focus node + neighbors
- Controls:
  - triple search-based coloring (subject/predicate/object term match)
  - node type toggles
  - node search by label
  - reset camera
  - distance visibility filter

## Scalability strategies and config points

- **Web Worker processing**: `src/workers/escoWorker.ts`
  - keeps JSON-LD flatten + parsing off the main thread
- **Incremental graph hydration**: chunk messages from worker
  - configurable `chunkSize` in `processPayload` (`src/App.tsx`)
- **LOD rendering**: node sphere resolution adapts by zoom level
  - configurable in `nodeResolution` (`src/App.tsx`)
- **Dynamic visibility filtering**: distance-based node/link culling
  - controlled by the *Distance visibility filter* slider in UI
- **GPU-friendly rendering path**: default sphere/link rendering from `react-force-graph-3d` / Three.js without custom per-node meshes

## Notes

- Search-driven node color is the only dynamic node coloring mode.
- Non-matching search results are dimmed, not removed, so context remains visible.
