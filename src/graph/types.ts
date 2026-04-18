export interface GraphNode {
  id: string
  label: string
  type: string
}

export interface GraphLink {
  source: string
  target: string
  type: string
}

export interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}

export interface GraphChunk {
  nodes: GraphNode[]
  links: GraphLink[]
  processed: number
  total: number
}

export type WorkerIncomingMessage =
  | { type: 'process'; payload: unknown; chunkSize?: number }
  | { type: 'cancel' }

export type WorkerOutgoingMessage =
  | { type: 'chunk'; payload: GraphChunk }
  | { type: 'complete'; payload: { totalNodes: number; totalLinks: number } }
  | { type: 'error'; payload: string }
