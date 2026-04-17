import type { GraphChunk, GraphData, GraphLink, GraphNode } from './types'

export const RELATIONSHIP_KEYS = [
  'broaderSkill',
  'relatedSkill',
  'hasEssentialSkill',
  'hasOptionalSkill',
] as const

const RELATION_SUFFIXES = RELATIONSHIP_KEYS.map((key) => key.toLowerCase())

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined

const findBySuffix = (
  record: Record<string, unknown>,
  suffixes: readonly string[],
): unknown => {
  for (const [key, value] of Object.entries(record)) {
    const lower = key.toLowerCase()
    if (suffixes.some((suffix) => lower.endsWith(suffix))) {
      return value
    }
  }

  return undefined
}

const extractType = (value: unknown): string => {
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string')
    return asString(first) ?? 'unknown'
  }

  return asString(value) ?? 'unknown'
}

const extractLabel = (record: Record<string, unknown>, fallback: string): string => {
  const directPreferredLabel = findBySuffix(record, ['preferredlabel', 'preflabel'])

  if (isRecord(directPreferredLabel)) {
    const languageValue =
      directPreferredLabel.en ??
      directPreferredLabel['@value'] ??
      Object.values(directPreferredLabel)[0]
    const directLabel = asString(languageValue)
    if (directLabel) {
      return directLabel
    }
  }

  if (Array.isArray(directPreferredLabel)) {
    const labelCandidate = directPreferredLabel.find((entry) => {
      if (!isRecord(entry)) {
        return false
      }

      return entry['@language'] === 'en' || typeof entry['@value'] === 'string'
    })

    if (isRecord(labelCandidate)) {
      const label = asString(labelCandidate['@value'])
      if (label) {
        return label
      }
    }
  }

  return fallback
}

const extractIdRefs = (value: unknown): string[] => {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractIdRefs(entry))
  }

  if (typeof value === 'string') {
    return [value]
  }

  if (isRecord(value)) {
    const idRef = asString(value['@id'])
    if (idRef) {
      return [idRef]
    }
  }

  return []
}

const relationEntries = (record: Record<string, unknown>): Array<[string, string[]]> => {
  const entries: Array<[string, string[]]> = []

  for (const [key, value] of Object.entries(record)) {
    const lower = key.toLowerCase()
    const relationIndex = RELATION_SUFFIXES.findIndex((relation) =>
      lower.endsWith(relation),
    )

    if (relationIndex === -1) {
      continue
    }

    const relationType = RELATIONSHIP_KEYS[relationIndex]
    const refs = extractIdRefs(value)
    if (refs.length > 0) {
      entries.push([relationType, refs])
    }
  }

  return entries
}

export const transformFlattened = (
  flattened: unknown,
  options?: {
    chunkSize?: number
    onChunk?: (chunk: GraphChunk) => void
    isCancelled?: () => boolean
  },
): GraphData => {
  const items = Array.isArray(flattened) ? flattened : []
  const total = items.length
  const chunkSize = Math.max(1, options?.chunkSize ?? 1000)

  const nodeMap = new Map<string, GraphNode>()
  const linkSet = new Set<string>()
  const links: GraphLink[] = []

  let pendingNodes: GraphNode[] = []
  let pendingLinks: GraphLink[] = []

  const flush = (processed: number): void => {
    if (!options?.onChunk) {
      pendingNodes = []
      pendingLinks = []
      return
    }

    if (pendingNodes.length === 0 && pendingLinks.length === 0) {
      return
    }

    options.onChunk({
      nodes: pendingNodes,
      links: pendingLinks,
      processed,
      total,
    })
    pendingNodes = []
    pendingLinks = []
  }

  for (let index = 0; index < items.length; index += 1) {
    if (options?.isCancelled?.()) {
      break
    }

    const rawItem = items[index]
    if (!isRecord(rawItem)) {
      continue
    }

    const id = asString(rawItem['@id'])
    if (!id) {
      continue
    }

    if (!nodeMap.has(id)) {
      const node: GraphNode = {
        id,
        type: extractType(rawItem['@type']),
        label: extractLabel(rawItem, id),
      }
      nodeMap.set(id, node)
      pendingNodes.push(node)
    }

    for (const [relationType, targets] of relationEntries(rawItem)) {
      for (const target of targets) {
        if (!target) {
          continue
        }

        if (!nodeMap.has(target)) {
          const syntheticNode: GraphNode = {
            id: target,
            label: target,
            type: 'unknown',
          }
          nodeMap.set(target, syntheticNode)
          pendingNodes.push(syntheticNode)
        }

        const key = `${id}|${target}|${relationType}`
        if (linkSet.has(key)) {
          continue
        }

        linkSet.add(key)
        const link: GraphLink = { source: id, target, type: relationType }
        links.push(link)
        pendingLinks.push(link)
      }
    }

    const processed = index + 1
    if (processed % chunkSize === 0) {
      flush(processed)
    }
  }

  flush(items.length)

  return {
    nodes: [...nodeMap.values()],
    links,
  }
}
