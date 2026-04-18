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
  broader: '#4cc9f0',
  narrower: '#7b8cde',
  isEssentialSkillFor: '#80ed99',
  isOptionalSkillFor: '#ffd166',
  relatedEssentialSkill: '#f72585',
  relatedOptionalSkill: '#ff6b6b',
}

const EMPTY_GRAPH: GraphData = { nodes: [], links: [] }
type LoadingPhase = 'idle' | 'fetching' | 'reading' | 'processing'

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
  const [status, setStatus] = useState('Load a pre-flattened ESCO JSON file.')
  const [progress, setProgress] = useState({ processed: 0, total: 0 })
  const [phaseProgress, setPhaseProgress] = useState({ loaded: 0, total: 0 })

  const [search, setSearch] = useState('')

  const [hiddenTypes, setHiddenTypes] = useState<Record<string, boolean>>({})
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null)
  const [minDegree, setMinDegree] = useState(0)

  const postWorkerMessage = useCallback((message: WorkerIncomingMessage) => {
    workerRef.current?.postMessage(message)
  }, [])

  const processText = useCallback(
    (text: string) => {
      setGraphData(EMPTY_GRAPH)
      setSelectedNodeId(null)
      setHoverNodeId(null)
      setProgress({ processed: 0, total: 0 })
      setLoading(true)
      setLoadingPhase('processing')
      setError('')
      setStatus('Processing...')
      postWorkerMessage({ type: 'cancel' })
      postWorkerMessage({ type: 'process', payload: text })
    },
    [postWorkerMessage],
  )

  useEffect(() => {
    const worker = new Worker(new URL('./workers/escoWorker.ts', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = (event: MessageEvent<WorkerOutgoingMessage>) => {
      const message = event.data

      if (message.type === 'progress') {
        setProgress({
          processed: message.payload.processed,
          total: message.payload.total,
        })
        return
      }

      if (message.type === 'complete') {
        setProgress({
          processed: message.payload.nodes.length,
          total: message.payload.nodes.length,
        })
        setLoading(false)
        setLoadingPhase('idle')
        setStatus(
          `${message.payload.nodes.length.toLocaleString()} nodes, ${message.payload.links.length.toLocaleString()} links — layout ready.`,
        )
        setGraphData(message.payload)
        return
      }

      if (message.type === 'error') {
        setLoading(false)
        setLoadingPhase('idle')
        setError(message.payload)
        setStatus('Failed to process the dataset.')
      }
    }

    workerRef.current = worker

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  const loadSample = useCallback(async () => {
    try {
      setLoading(true)
      setLoadingPhase('fetching')
      setStatus('Downloading sample dataset...')
      setError('')
      setPhaseProgress({ loaded: 0, total: 0 })
      const response = await fetch('/sample-esco.json')
      if (!response.ok) {
        throw new Error(`Unable to fetch sample dataset (${response.status})`)
      }

      const header = response.headers.get('Content-Length')
      const contentLength = header ? Number(header) : 0
      if (contentLength <= 0 || !response.body) {
        const text = await response.text()
        processText(text)
        return
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
      processText(new TextDecoder().decode(combined))
    } catch (loadError) {
      setLoading(false)
      setLoadingPhase('idle')
      setError(loadError instanceof Error ? loadError.message : 'Unable to load sample file')
    }
  }, [processText])

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

        processText(text)
      } catch (loadError) {
        setLoading(false)
        setLoadingPhase('idle')
        setError(loadError instanceof Error ? loadError.message : 'Unable to read file')
      } finally {
        input.value = ''
      }
    },
    [processText],
  )

  const nodeTypes = useMemo(() => {
    return [...new Set(graphData.nodes.map((node) => node.type))].sort((left, right) =>
      left.localeCompare(right),
    )
  }, [graphData.nodes])

  const allLanguages = useMemo(() => {
    const langs = new Set<string>()
    for (const node of graphData.nodes) {
      for (const lang of node.languages) {
        langs.add(lang)
      }
    }
    return [...langs].sort((left, right) => left.localeCompare(right))
  }, [graphData.nodes])

  const filteredGraph = useMemo<GraphData>(() => {
    // First pass: filter by type and language
    const candidateNodes = graphData.nodes.filter((node) => {
      if (hiddenTypes[node.type]) return false
      if (selectedLanguage && !node.languages.includes(selectedLanguage)) return false
      return true
    })
    const candidateIds = new Set(candidateNodes.map((node) => node.id))

    const links = graphData.links.filter(
      (link) => candidateIds.has(asNodeId(link.source)) && candidateIds.has(asNodeId(link.target)),
    )

    // Compute dynamic degree within filtered set
    const degreeMap = new Map<string, number>()
    for (const link of links) {
      const src = asNodeId(link.source)
      const tgt = asNodeId(link.target)
      degreeMap.set(src, (degreeMap.get(src) ?? 0) + 1)
      degreeMap.set(tgt, (degreeMap.get(tgt) ?? 0) + 1)
    }

    // Second pass: apply min-degree filter
    const nodes = minDegree > 0
      ? candidateNodes.filter((node) => (degreeMap.get(node.id) ?? 0) >= minDegree)
      : candidateNodes

    if (minDegree > 0) {
      const nodeIds = new Set(nodes.map((node) => node.id))
      return {
        nodes,
        links: links.filter((link) => nodeIds.has(asNodeId(link.source)) && nodeIds.has(asNodeId(link.target))),
      }
    }

    return { nodes, links }
  }, [graphData.links, graphData.nodes, hiddenTypes, minDegree, selectedLanguage])

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

  // Track neighbor relationship roles for hierarchy visualization
  type NeighborRole = 'parent' | 'child' | 'essentialSkill' | 'optionalSkill' | 'other'

  const neighborRoles = useMemo(() => {
    if (!selectedNodeId) return new Map<string, NeighborRole>()
    const roles = new Map<string, NeighborRole>()
    for (const link of filteredGraph.links) {
      const source = asNodeId(link.source)
      const target = asNodeId(link.target)
      let neighborId: string | null = null
      let role: NeighborRole = 'other'
      if (source === selectedNodeId) {
        neighborId = target
        if (link.type === 'broader') role = 'parent'
        else if (link.type === 'narrower') role = 'child'
        else if (link.type === 'isEssentialSkillFor' || link.type === 'relatedEssentialSkill') role = 'essentialSkill'
        else if (link.type === 'isOptionalSkillFor' || link.type === 'relatedOptionalSkill') role = 'optionalSkill'
      } else if (target === selectedNodeId) {
        neighborId = source
        if (link.type === 'broader') role = 'child'
        else if (link.type === 'narrower') role = 'parent'
        else if (link.type === 'isEssentialSkillFor' || link.type === 'relatedEssentialSkill') role = 'essentialSkill'
        else if (link.type === 'isOptionalSkillFor' || link.type === 'relatedOptionalSkill') role = 'optionalSkill'
      }
      if (neighborId && !roles.has(neighborId)) roles.set(neighborId, role)
    }
    return roles
  }, [filteredGraph.links, selectedNodeId])

  const ROLE_COLORS: Record<NeighborRole, string> = {
    parent: '#4cc9f0',
    child: '#80ed99',
    essentialSkill: '#f72585',
    optionalSkill: '#ffd166',
    other: '#9aa0a6',
  }

  const ROLE_LABELS: Record<NeighborRole, string> = {
    parent: '↑ Parents (broader)',
    child: '↓ Children (narrower)',
    essentialSkill: '★ Essential skills',
    optionalSkill: '☆ Optional skills',
    other: '◇ Other',
  }

  const groupedNeighbors = useMemo(() => {
    if (neighborRoles.size === 0) return null
    const groups: Record<NeighborRole, { id: string; label: string }[]> = {
      parent: [], child: [], essentialSkill: [], optionalSkill: [], other: [],
    }
    for (const [id, role] of neighborRoles) {
      const node = nodeById.get(id)
      groups[role].push({ id, label: node?.label ?? id })
    }
    for (const role of Object.keys(groups) as NeighborRole[]) {
      groups[role].sort((a, b) => a.label.localeCompare(b.label))
    }
    return groups
  }, [neighborRoles, nodeById])

  const searchLower = search.trim().toLowerCase()

  const matchingSets = useMemo(() => {
    if (!searchLower) {
      return {
        nodeIds: new Set<string>(),
        linkIds: new Set<string>(),
      }
    }

    const matchingNodeIds = new Set<string>()
    const matchingLinkIds = new Set<string>()

    for (const node of filteredGraph.nodes) {
      const isMatch =
        node.label.toLowerCase().includes(searchLower) ||
        node.id.toLowerCase().includes(searchLower) ||
        node.type.toLowerCase().includes(searchLower)

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
        link.type.toLowerCase().includes(searchLower) ||
        sourceNode?.label.toLowerCase().includes(searchLower) ||
        targetNode?.label.toLowerCase().includes(searchLower)

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
  }, [filteredGraph.links, filteredGraph.nodes, nodeById, searchLower])

  const matchingNodes = useMemo(() => {
    if (matchingSets.nodeIds.size === 0) return []
    return filteredGraph.nodes
      .filter((node) => matchingSets.nodeIds.has(node.id))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [filteredGraph.nodes, matchingSets.nodeIds])

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

  const flyToNode = useCallback((nodeId: string) => {
    setSearch('')
    setSelectedNodeId(nodeId)
    const node = nodeById.get(nodeId)
    if (node?.x !== undefined && node?.y !== undefined && node?.z !== undefined) {
      graphRef.current?.cameraPosition(
        { x: node.x * 1.5, y: node.y * 1.5, z: node.z * 1.5 },
        { x: node.x, y: node.y, z: node.z },
        800,
      )
    }
  }, [nodeById])

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : undefined

  const hasSearch = searchLower.length > 0

  // Nodes whose links should be visible (hovered + selected + their neighbors)
  const activeLinkNodeIds = useMemo(() => {
    const ids = new Set<string>()
    if (hoverNodeId) {
      ids.add(hoverNodeId)
    }
    if (selectedNodeId) {
      ids.add(selectedNodeId)
    }
    return ids
  }, [hoverNodeId, selectedNodeId])

  return (
    <main className="layout">
      <aside className="controls">
        <h1>ESCO 3D Graph</h1>
        <p className="muted">{status}</p>

        {loading ? (
          <div className="loading-progress">
            {(() => {
              const hasProcessingProgress = loadingPhase === 'processing' && progress.total > 0
              const hasPhaseProgress =
                (loadingPhase === 'fetching' || loadingPhase === 'reading') && phaseProgress.total > 0

              return (
                <>
                  <progress
                    max={
                      hasProcessingProgress
                        ? Math.max(progress.total, 1)
                        : hasPhaseProgress
                          ? phaseProgress.total
                          : undefined
                    }
                    value={
                      hasProcessingProgress
                        ? progress.processed
                        : hasPhaseProgress
                          ? phaseProgress.loaded
                          : undefined
                    }
                  />
                  <p className="muted">
                    {hasProcessingProgress
                      ? `Processing ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()} entries...`
                      : loadingPhase === 'fetching' && phaseProgress.total > 0
                        ? `Downloading ${formatBytes(phaseProgress.loaded)} / ${formatBytes(phaseProgress.total)}...`
                        : loadingPhase === 'fetching'
                          ? 'Downloading...'
                          : loadingPhase === 'reading' && phaseProgress.total > 0
                            ? `Reading file ${formatBytes(phaseProgress.loaded)} / ${formatBytes(phaseProgress.total)}...`
                            : loadingPhase === 'reading'
                              ? 'Reading file...'
                              : 'Working...'}
                  </p>
                </>
              )
            })()}
          </div>
        ) : null}
        {error ? <p className="error">{error}</p> : null}

        <div className="group">
          <button type="button" onClick={loadSample}>
            Load sample dataset
          </button>
          <label className="file-input">
            <span>Load local file</span>
            <input type="file" accept=".json" onChange={handleLocalFile} />
          </label>
        </div>

        <div className="group">
          <label htmlFor="search">Search</label>
          <input
            id="search"
            type="search"
            placeholder="e.g. statistics, Occupation, data analyst..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {hasSearch ? (
            <p className="muted">{matchingNodes.length} matches</p>
          ) : null}
          {matchingNodes.length > 0 ? (
            <ul className="search-results">
              {matchingNodes.slice(0, 20).map((node) => (
                <li key={node.id}>
                  <button type="button" onClick={() => flyToNode(node.id)}>
                    {node.label}
                  </button>
                </li>
              ))}
              {matchingNodes.length > 20 ? (
                <li className="muted">…and {matchingNodes.length - 20} more</li>
              ) : null}
            </ul>
          ) : null}
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
              setSearch('')
              setSelectedNodeId(null)
            }}
          >
            Clear highlights
          </button>
        </div>

        <div className="group">
          <label htmlFor="minDegree">
            Min connections ({minDegree > 0 ? `≥ ${minDegree}` : 'off'})
          </label>
          <input
            id="minDegree"
            type="range"
            min={0}
            max={100}
            step={1}
            value={minDegree}
            onChange={(event) => setMinDegree(Number(event.target.value))}
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

        {allLanguages.length > 0 ? (
          <div className="group">
            <h2>Languages</h2>
            <div className="types">
              <label>
                <input
                  type="radio"
                  name="language"
                  checked={selectedLanguage === null}
                  onChange={() => setSelectedLanguage(null)}
                />
                <span>All</span>
              </label>
              {allLanguages.map((lang) => (
                <label key={lang}>
                  <input
                    type="radio"
                    name="language"
                    checked={selectedLanguage === lang}
                    onChange={() => setSelectedLanguage(lang)}
                  />
                  <span>{lang}</span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        <div className="group details">
          <h2>Node details</h2>
          {selectedNode ? (
            <>
              <p>
                <strong>{selectedNode.label}</strong>
              </p>
              <p>ID: {String(selectedNode.id).startsWith('http') ? <a href={String(selectedNode.id)} target="_blank" rel="noopener noreferrer">{selectedNode.id}</a> : selectedNode.id}</p>
              <p>Type: {selectedNode.type}</p>
              <p>Languages: {selectedNode.languages.length > 0 ? selectedNode.languages.join(', ') : 'none'}</p>
              <p>Connections: {selectedNode.degree}</p>
              {groupedNeighbors && (
                <div className="hierarchy">
                  {(Object.keys(ROLE_LABELS) as NeighborRole[]).map((role) => {
                    const items = groupedNeighbors[role]
                    if (items.length === 0) return null
                    return (
                      <div key={role} className="hierarchy-group">
                        <p style={{ color: ROLE_COLORS[role], margin: '0.5rem 0 0.2rem' }}>
                          <strong>{ROLE_LABELS[role]} ({items.length})</strong>
                        </p>
                        <ul className="hierarchy-list">
                          {items.map((item) => (
                            <li key={item.id}>
                              <button type="button" onClick={() => flyToNode(item.id)}>
                                {item.label}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            <p className="muted">Click a node to inspect it.</p>
          )}
        </div>
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
          nodeResolution={4}
          linkOpacity={0.35}
          warmupTicks={0}
          cooldownTicks={0}
          onEngineStop={() => {
            setLoading(false)
            setLoadingPhase('idle')
          }}
          nodeLabel={(node) => `${node.label} (${node.type}) [${node.degree} links]`}
          onNodeHover={(node) => setHoverNodeId(node?.id ?? null)}
          onNodeClick={(node) => setSelectedNodeId(node.id)}
          onBackgroundClick={() => setSelectedNodeId(null)}
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
            if (hasSearch) {
              return matchingSets.nodeIds.has(node.id) ? '#ffb703' : 'rgba(143, 153, 166, 0.12)'
            }

            if (selectedLanguage) {
              return node.languages.includes(selectedLanguage)
                ? '#4cc9f0'
                : 'rgba(143, 153, 166, 0.15)'
            }

            if (selectedNodeId) {
              if (node.id === selectedNodeId) return '#ffffff'
              const role = neighborRoles.get(node.id)
              if (role) return ROLE_COLORS[role]
              return 'rgba(143, 153, 166, 0.08)'
            }

            return '#8f99a6'
          }}
          linkVisibility={(link) => {
            if (activeLinkNodeIds.size === 0 && !hasSearch) {
              return false
            }

            const sourceId = asNodeId(link.source)
            const targetId = asNodeId(link.target)

            if (hasSearch) {
              const key = linkKey({ source: sourceId, target: targetId, type: link.type })
              return matchingSets.linkIds.has(key)
            }

            return activeLinkNodeIds.has(sourceId) || activeLinkNodeIds.has(targetId)
          }}
          linkColor={(link) => {
            return RELATION_COLORS[link.type] ?? '#9aa0a6'
          }}
          linkWidth={1.5}
          linkDirectionalArrowLength={(link) => {
            if (!selectedNodeId) return 0
            const sourceId = asNodeId(link.source)
            const targetId = asNodeId(link.target)
            if (sourceId === selectedNodeId || targetId === selectedNodeId) return 4
            return 0
          }}
          linkDirectionalArrowRelPos={1}
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
          enableNodeDrag={false}
          controlType="trackball"
        />
      </section>
    </main>
  )
}

export default App
