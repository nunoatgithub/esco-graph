export interface GraphNode {
  id: string
  label: string
  type: string
  languages: string[]
  degree: number
  x?: number
  y?: number
  z?: number
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

export type WorkerIncomingMessage =
  | { type: 'process'; payload: string }
  | { type: 'cancel' }

export type WorkerOutgoingMessage =
  | { type: 'progress'; payload: { processed: number; total: number } }
  | { type: 'complete'; payload: GraphData }
  | { type: 'error'; payload: string }
