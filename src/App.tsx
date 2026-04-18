import type { ChangeEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-3d'
import './App.css'
import type {
  GraphData,
  GraphLink,
  GraphNode,
  WorkerIncomingMessage,
  WorkerOutgoingMessage,
} from './graph/types'

interface RenderNode extends GraphNode {
  x?: number
  y?: number
  z?: number
}

interface RenderLink {
  source: string | RenderNode
  target: string | RenderNode
  type: GraphLink['type']
}

const RELATION_COLORS: Record<string, string> = {
  broaderSkill: '#4cc9f0',
  relatedSkill: '#f72585',
  hasEssentialSkill: '#80ed99',
  hasOptionalSkill: '#ffd166',
}

const EMPTY_GRAPH: GraphData = { nodes: [], links: [] }
type LoadingPhase = 'idle' | 'fetching' | 'reading' | 'parsing' | 'processing'

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const asNodeId = (nodeRef: string | RenderNode): string =>
  typeof nodeRef === 'string' ? nodeRef : nodeRef.id

const linkKey = (link: Pick<GraphLink, 'source' | 'target' | 'type'>): string =>
  `${link.source}|${link.target}|${link.type}`

const App = () => {
  const graphRef = useRef<
    ForceGraphMethods<NodeObject<RenderNode>, LinkObject<RenderNode, RenderLink>> | undefined
  >(undefined)
  const workerRef = useRef<Worker | null>(null)

  const [graphData, setGraphData] = useState<GraphData>(EMPTY_GRAPH)
  const [loading, setLoading] = useState(false)
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>('idle')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('Load sample data, a local JSON-LD file, or a URL.')
  const [progress, setProgress] = useState({ processed: 0, total: 0 })
  const [phaseProgress, setPhaseProgress] = useState({ loaded: 0, total: 0 })

  const [tripleSearch, setTripleSearch] = useState('')
  const [nodeSearch, setNodeSearch] = useState('')
  const [datasetUrl, setDatasetUrl] = useState('')

  const [hiddenTypes, setHiddenTypes] = useState<Record<string, boolean>>({})
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null)
  const [zoomLevel, setZoomLevel] = useState(1)
  const [visibilityDistance, setVisibilityDistance] = useState(0)
  const zoomLevelRef = useRef(zoomLevel)

  const postWorkerMessage = useCallback((message: WorkerIncomingMessage) => {
    workerRef.current?.postMessage(message)
  }, [])

  const resetGraph = useCallback(() => {
    setGraphData(EMPTY_GRAPH)
    setSelectedNodeId(null)
    setHoverNodeId(null)
    setProgress({ processed: 0, total: 0 })
    setPhaseProgress({ loaded: 0, total: 0 })
  }, [])

  const processPayload = useCallback(
    (payload: unknown) => {
      resetGraph()
      setLoading(true)
      setLoadingPhase('processing')
      setError('')
      setStatus('Flattening and transforming JSON-LD in worker...')
      postWorkerMessage({ type: 'cancel' })
      postWorkerMessage({ type: 'process', payload, chunkSize: 800 })
    },
    [postWorkerMessage, resetGraph],
  )

  useEffect(() => {
    const worker = new Worker(new URL('./workers/escoWorker.ts', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = (event: MessageEvent<WorkerOutgoingMessage>) => {
      const message = event.data

      if (message.type === 'chunk') {
        setGraphData((current) => ({
          nodes: [...current.nodes, ...message.payload.nodes],
          links: [...current.links, ...message.payload.links],
        }))
        setProgress({
          processed: message.payload.processed,
          total: message.payload.total,
        })
        return
      }

      if (message.type === 'complete') {
        setLoading(false)
        setLoadingPhase('idle')
        setStatus(
          `Loaded ${message.payload.totalNodes.toLocaleString()} nodes and ${message.payload.totalLinks.toLocaleString()} links.`,
        )
        return
      }

      if (message.type === 'error') {
        setLoading(false)
        setLoadingPhase('idle')
        setError(message.payload)
        setStatus('Failed to process the JSON-LD dataset.')
      }
    }

    workerRef.current = worker

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  const readResponseWithProgress = useCallback(
    async (response: Response): Promise<string> => {
      const contentLength = Number(response.headers.get('Content-Length') ?? 0)
      if (!contentLength || !response.body) {
        return response.text()
      }

      setPhaseProgress({ loaded: 0, total: contentLength })
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let loaded = 0

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        loaded += value.byteLength
        setPhaseProgress({ loaded, total: contentLength })
      }

      const combined = new Uint8Array(loaded)
      let offset = 0
      for (const chunk of chunks) {
        combined.set(chunk, offset)
        offset += chunk.byteLength
      }
      return new TextDecoder().decode(combined)
    },
    [],
  )

  const loadSample = useCallback(async () => {
    try {
      setLoading(true)
      setLoadingPhase('fetching')
      setStatus('Downloading sample dataset...')
      setError('')
      setPhaseProgress({ loaded: 0, total: 0 })
      const response = await fetch('/sample-esco.jsonld')
      if (!response.ok) {
        throw new Error(`Unable to fetch sample dataset (${response.status})`)
      }

      const text = await readResponseWithProgress(response)
      setLoadingPhase('parsing')
      setStatus('Parsing sample JSON-LD...')
      const payload = JSON.parse(text) as unknown
      processPayload(payload)
    } catch (loadError) {
      setLoading(false)
      setLoadingPhase('idle')
      setError(loadError instanceof Error ? loadError.message : 'Unable to load sample file')
    }
  }, [processPayload, readResponseWithProgress])

  const loadFromUrl = useCallback(async () => {
    if (!datasetUrl.trim()) {
      return
    }

    try {
      setLoading(true)
      setLoadingPhase('fetching')
      setStatus('Downloading dataset from URL...')
      setError('')
      setPhaseProgress({ loaded: 0, total: 0 })
      const response = await fetch(datasetUrl)
      if (!response.ok) {
        throw new Error(`Unable to fetch URL (${response.status})`)
      }

      const text = await readResponseWithProgress(response)
      setLoadingPhase('parsing')
      setStatus('Parsing JSON-LD from URL...')
      const payload = JSON.parse(text) as unknown
      processPayload(payload)
    } catch (loadError) {
      setLoading(false)
      setLoadingPhase('idle')
      setError(loadError instanceof Error ? loadError.message : 'Unable to load URL')
    }
  }, [datasetUrl, processPayload, readResponseWithProgress])

  const handleLocalFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.target
      const file = input.files?.[0]
      if (!file) {
        return
      }

      try {
        setLoading(true)
        setLoadingPhase('reading')
        setStatus(`Reading ${file.name}...`)
        setError('')
        setPhaseProgress({ loaded: 0, total: file.size })

        const text = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onprogress = (progressEvent) => {
            if (progressEvent.lengthComputable) {
              setPhaseProgress({ loaded: progressEvent.loaded, total: progressEvent.total })
            }
          }
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = () => reject(reader.error)
          reader.readAsText(file)
        })

        setLoadingPhase('parsing')
        setStatus(`Parsing ${file.name}...`)
        const payload = JSON.parse(text) as unknown
        processPayload(payload)
      } catch (loadError) {
        setLoading(false)
        setLoadingPhase('idle')
        setError(loadError instanceof Error ? loadError.message : 'Unable to parse JSON-LD file')
      } finally {
        input.value = ''
      }
    },
    [processPayload],
  )

  const nodeTypes = useMemo(() => {
    return [...new Set(graphData.nodes.map((node) => node.type))].sort((left, right) =>
      left.localeCompare(right),
    )
  }, [graphData.nodes])

  const filteredGraph = useMemo<GraphData>(() => {
    const nodes = graphData.nodes.filter((node) => !hiddenTypes[node.type])
    const nodeIds = new Set(nodes.map((node) => node.id))

    const links = graphData.links.filter(
      (link) => nodeIds.has(link.source) && nodeIds.has(link.target),
    )

    return { nodes, links }
  }, [graphData.links, graphData.nodes, hiddenTypes])

  const nodeById = useMemo(() => {
    const map = new Map<string, RenderNode>()
    for (const node of filteredGraph.nodes) {
      map.set(node.id, node)
    }
    return map
  }, [filteredGraph.nodes])

  const neighborsById = useMemo(() => {
    const map = new Map<string, Set<string>>()

    for (const link of filteredGraph.links) {
      const source = asNodeId(link.source)
      const target = asNodeId(link.target)

      if (!map.has(source)) {
        map.set(source, new Set())
      }
      if (!map.has(target)) {
        map.set(target, new Set())
      }

      map.get(source)?.add(target)
      map.get(target)?.add(source)
    }

    return map
  }, [filteredGraph.links])

  const tripleSearchLower = tripleSearch.trim().toLowerCase()

  const matchingSets = useMemo(() => {
    if (!tripleSearchLower) {
      return {
        nodeIds: new Set<string>(),
        linkIds: new Set<string>(),
      }
    }

    const matchingNodeIds = new Set<string>()
    const matchingLinkIds = new Set<string>()

    for (const node of filteredGraph.nodes) {
      const isMatch =
        node.label.toLowerCase().includes(tripleSearchLower) ||
        node.id.toLowerCase().includes(tripleSearchLower) ||
        node.type.toLowerCase().includes(tripleSearchLower)

      if (isMatch) {
        matchingNodeIds.add(node.id)
      }
    }

    for (const link of filteredGraph.links) {
      const sourceId = asNodeId(link.source)
      const targetId = asNodeId(link.target)
      const sourceNode = nodeById.get(sourceId)
      const targetNode = nodeById.get(targetId)

      const linkMatches =
        link.type.toLowerCase().includes(tripleSearchLower) ||
        sourceId.toLowerCase().includes(tripleSearchLower) ||
        targetId.toLowerCase().includes(tripleSearchLower) ||
        sourceNode?.label.toLowerCase().includes(tripleSearchLower) ||
        targetNode?.label.toLowerCase().includes(tripleSearchLower)

      if (linkMatches) {
        matchingLinkIds.add(linkKey({ source: sourceId, target: targetId, type: link.type }))
        matchingNodeIds.add(sourceId)
        matchingNodeIds.add(targetId)
      }
    }

    return {
      nodeIds: matchingNodeIds,
      linkIds: matchingLinkIds,
    }
  }, [filteredGraph.links, filteredGraph.nodes, nodeById, tripleSearchLower])

  const highlightedNodeIds = useMemo(() => {
    if (!selectedNodeId) {
      return new Set<string>()
    }

    const highlighted = new Set<string>([selectedNodeId])
    const neighbors = neighborsById.get(selectedNodeId)

    if (neighbors) {
      for (const neighbor of neighbors) {
        highlighted.add(neighbor)
      }
    }

    return highlighted
  }, [neighborsById, selectedNodeId])

  const onFindNode = useCallback(() => {
    const searchValue = nodeSearch.trim().toLowerCase()
    if (!searchValue) {
      return
    }

    const match = filteredGraph.nodes.find((node) =>
      node.label.toLowerCase().includes(searchValue),
    )

    if (!match) {
      setStatus(`No node found for "${nodeSearch}".`)
      return
    }

    setSelectedNodeId(match.id)
    setStatus(`Focused node: ${match.label} (${match.type})`)

    const currentNode = nodeById.get(match.id)
    if (currentNode?.x !== undefined && currentNode?.y !== undefined && currentNode?.z !== undefined) {
      graphRef.current?.cameraPosition(
        {
          x: currentNode.x * 1.5,
          y: currentNode.y * 1.5,
          z: currentNode.z * 1.5,
        },
        { x: currentNode.x, y: currentNode.y, z: currentNode.z },
        800,
      )
    }
  }, [filteredGraph.nodes, nodeById, nodeSearch])

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : undefined

  const hasSearch = tripleSearchLower.length > 0
  const maxDistanceSq = visibilityDistance > 0 ? visibilityDistance * visibilityDistance : 0

  useEffect(() => {
    zoomLevelRef.current = zoomLevel
  }, [zoomLevel])

  return (
    <main className="layout">
      <aside className="controls">
        <h1>ESCO 3D Graph</h1>
        <p className="muted">{status}</p>

        <div className="group">
          <button type="button" onClick={loadSample}>
            Load sample ESCO JSON-LD
          </button>
          <label className="file-input">
            <span>Load local JSON-LD</span>
            <input type="file" accept="application/ld+json,.json,.jsonld" onChange={handleLocalFile} />
          </label>
          <input
            type="url"
            placeholder="https://.../esco.jsonld"
            value={datasetUrl}
            onChange={(event) => setDatasetUrl(event.target.value)}
          />
          <button type="button" onClick={loadFromUrl}>
            Load URL
          </button>
        </div>

        <div className="group">
          <label htmlFor="tripleSearch">Triple search (subject/predicate/object)</label>
          <input
            id="tripleSearch"
            type="search"
            placeholder="e.g. relatedSkill, statistics, skill:..."
            value={tripleSearch}
            onChange={(event) => setTripleSearch(event.target.value)}
          />
        </div>

        <div className="group inline">
          <input
            type="search"
            placeholder="Find node by label"
            value={nodeSearch}
            onChange={(event) => setNodeSearch(event.target.value)}
          />
          <button type="button" onClick={onFindNode}>
            Find node
          </button>
        </div>

        <div className="group inline">
          <button
            type="button"
            onClick={() => {
              graphRef.current?.zoomToFit(600, 40)
            }}
          >
            Reset camera
          </button>
          <button
            type="button"
            onClick={() => {
              setTripleSearch('')
              setNodeSearch('')
              setSelectedNodeId(null)
            }}
          >
            Clear highlights
          </button>
        </div>

        <div className="group">
          <label htmlFor="distance">
            Distance visibility filter ({visibilityDistance > 0 ? visibilityDistance : 'off'})
          </label>
          <input
            id="distance"
            type="range"
            min={0}
            max={400}
            step={20}
            value={visibilityDistance}
            onChange={(event) => setVisibilityDistance(Number(event.target.value))}
          />
        </div>

        <div className="group">
          <h2>Node types</h2>
          <div className="types">
            {nodeTypes.map((nodeType) => (
              <label key={nodeType}>
                <input
                  type="checkbox"
                  checked={!hiddenTypes[nodeType]}
                  onChange={(event) => {
                    const checked = event.target.checked
                    setHiddenTypes((current) => ({
                      ...current,
                      [nodeType]: !checked,
                    }))
                  }}
                />
                <span>{nodeType}</span>
              </label>
            ))}
            {nodeTypes.length === 0 ? <p className="muted">No loaded node types yet.</p> : null}
          </div>
        </div>

        <div className="group details">
          <h2>Node details</h2>
          {selectedNode ? (
            <>
              <p>
                <strong>{selectedNode.label}</strong>
              </p>
              <p>ID: {selectedNode.id}</p>
              <p>Type: {selectedNode.type}</p>
              <p>Neighbors: {neighborsById.get(selectedNode.id)?.size ?? 0}</p>
            </>
          ) : (
            <p className="muted">Click a node to inspect it.</p>
          )}
        </div>

        {loading ? (
          <div className="loading-progress">
            <progress
              max={
                loadingPhase === 'processing' && progress.total > 0
                  ? Math.max(progress.total, 1)
                  : (loadingPhase === 'fetching' || loadingPhase === 'reading') && phaseProgress.total > 0
                    ? phaseProgress.total
                    : undefined
              }
              value={
                loadingPhase === 'processing' && progress.total > 0
                  ? progress.processed
                  : (loadingPhase === 'fetching' || loadingPhase === 'reading') && phaseProgress.total > 0
                    ? phaseProgress.loaded
                    : undefined
              }
            />
            <p className="muted">
              {loadingPhase === 'processing' && progress.total > 0
                ? `Processing ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()} entries...`
                : loadingPhase === 'fetching' && phaseProgress.total > 0
                  ? `Downloading ${formatBytes(phaseProgress.loaded)} / ${formatBytes(phaseProgress.total)}...`
                  : loadingPhase === 'fetching'
                    ? 'Downloading...'
                    : loadingPhase === 'reading' && phaseProgress.total > 0
                      ? `Reading file ${formatBytes(phaseProgress.loaded)} / ${formatBytes(phaseProgress.total)}...`
                      : loadingPhase === 'reading'
                        ? 'Reading file...'
                        : loadingPhase === 'parsing'
                          ? 'Parsing JSON-LD...'
                          : loadingPhase === 'processing'
                            ? 'Preparing to process...'
                            : 'Working...'}
            </p>
          </div>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
      </aside>

      <section className="graph">
        <ForceGraph3D<RenderNode, RenderLink>
          ref={graphRef}
          graphData={{
            nodes: filteredGraph.nodes,
            links: filteredGraph.links,
          }}
          backgroundColor="#090b10"
          nodeRelSize={3}
          nodeResolution={zoomLevel > 2 ? 10 : zoomLevel > 1 ? 8 : 4}
          linkOpacity={zoomLevel > 1 ? 0.35 : 0.2}
          nodeLabel={(node) => `${node.label} (${node.type})`}
          onEngineTick={() => {
            const camera = graphRef.current?.camera()
            if (!camera) {
              return
            }

            const distance = Math.sqrt(
              camera.position.x * camera.position.x +
                camera.position.y * camera.position.y +
                camera.position.z * camera.position.z,
            )

            const nextLevel = distance > 1300 ? 0.6 : distance > 700 ? 1 : 2
            if (nextLevel !== zoomLevelRef.current) {
              setZoomLevel(nextLevel)
            }
          }}
          onNodeHover={(node) => setHoverNodeId(node?.id ?? null)}
          onNodeClick={(node) => setSelectedNodeId(node.id)}
          onBackgroundClick={() => setSelectedNodeId(null)}
          nodeVisibility={(node) => {
            if (visibilityDistance <= 0) {
              return true
            }

            if (
              typeof node.x !== 'number' ||
              typeof node.y !== 'number' ||
              typeof node.z !== 'number'
            ) {
              return true
            }

            const distanceSq = node.x * node.x + node.y * node.y + node.z * node.z
            return distanceSq <= maxDistanceSq
          }}
          nodeVal={(node) => {
            if (highlightedNodeIds.has(node.id)) {
              return 8
            }

            if (hoverNodeId === node.id) {
              return 6
            }

            return 3
          }}
          nodeColor={(node) => {
            if (!hasSearch) {
              return '#8f99a6'
            }

            return matchingSets.nodeIds.has(node.id) ? '#ffb703' : 'rgba(143, 153, 166, 0.12)'
          }}
          linkVisibility={(link) => {
            if (visibilityDistance <= 0) {
              return true
            }

            const source = typeof link.source === 'string' ? nodeById.get(link.source) : link.source
            const target = typeof link.target === 'string' ? nodeById.get(link.target) : link.target

            if (!source || !target) {
              return false
            }

            if (
              typeof source.x !== 'number' ||
              typeof source.y !== 'number' ||
              typeof source.z !== 'number' ||
              typeof target.x !== 'number' ||
              typeof target.y !== 'number' ||
              typeof target.z !== 'number'
            ) {
              return true
            }

            const sourceDistance = source.x * source.x + source.y * source.y + source.z * source.z
            const targetDistance = target.x * target.x + target.y * target.y + target.z * target.z

            return sourceDistance <= maxDistanceSq && targetDistance <= maxDistanceSq
          }}
          linkColor={(link) => {
            const sourceId = asNodeId(link.source)
            const targetId = asNodeId(link.target)
            const key = linkKey({ source: sourceId, target: targetId, type: link.type })

            if (!hasSearch) {
              return RELATION_COLORS[link.type] ?? '#9aa0a6'
            }

            return matchingSets.linkIds.has(key)
              ? RELATION_COLORS[link.type] ?? '#ffffff'
              : 'rgba(154, 160, 166, 0.1)'
          }}
          linkWidth={(link) => {
            const sourceId = asNodeId(link.source)
            const targetId = asNodeId(link.target)

            if (
              selectedNodeId &&
              (sourceId === selectedNodeId || targetId === selectedNodeId)
            ) {
              return 2
            }

            return 0.7
          }}
          linkDirectionalParticles={(link) => {
            const sourceId = asNodeId(link.source)
            const targetId = asNodeId(link.target)

            if (
              selectedNodeId &&
              (sourceId === selectedNodeId || targetId === selectedNodeId)
            ) {
              return 2
            }

            return 0
          }}
          linkDirectionalParticleWidth={2}
          enableNodeDrag
          cooldownTicks={120}
        />
      </section>
    </main>
  )
}

export default App
