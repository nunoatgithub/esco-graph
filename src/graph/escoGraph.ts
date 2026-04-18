import type { GraphData, GraphLink, GraphNode } from './types'

export const RELATIONSHIP_KEYS = [
  'broader',
  'narrower',
  'isEssentialSkillFor',
  'isOptionalSkillFor',
  'relatedEssentialSkill',
  'relatedOptionalSkill',
] as const

const RELATION_SUFFIXES = RELATIONSHIP_KEYS.map((key) => key.toLowerCase())

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined

const extractType = (value: unknown): string => {
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string')
    return asString(first) ?? 'unknown'
  }

  return asString(value) ?? 'unknown'
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
    onProgress?: (processed: number, total: number) => void
    isCancelled?: () => boolean
  },
): GraphData => {
  const items = Array.isArray(flattened) ? flattened : []
  const total = items.length
  const progressInterval = Math.max(1, Math.floor(total / 100))

  const nodeMap = new Map<string, GraphNode>()
  const linkSet = new Set<string>()
  const links: GraphLink[] = []

  // First pass: register all entities as nodes
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
      const languages = Array.isArray(rawItem.languages)
        ? rawItem.languages.filter((l: unknown) => typeof l === 'string') as string[]
        : []
      nodeMap.set(id, {
        id,
        type: extractType(rawItem['@type']),
        label: asString(rawItem.preferredLabel) ?? id,
        languages,
        degree: 0,
        x: typeof rawItem.x === 'number' ? rawItem.x : undefined,
        y: typeof rawItem.y === 'number' ? rawItem.y : undefined,
        z: typeof rawItem.z === 'number' ? rawItem.z : undefined,
      })
    }

    if ((index + 1) % progressInterval === 0) {
      options?.onProgress?.(index + 1, total)
    }
  }

  // Second pass: build links (only between known nodes)
  for (const item of items) {
    if (options?.isCancelled?.()) {
      break
    }

    const rawItem = item as Record<string, unknown>
    const id = asString(rawItem['@id'])
    if (!id || !nodeMap.has(id)) continue

    for (const [relationType, targets] of relationEntries(rawItem)) {
      for (const target of targets) {
        if (!target || !nodeMap.has(target)) {
          continue
        }

        const key = `${id}|${target}|${relationType}`
        if (!linkSet.has(key)) {
          linkSet.add(key)
          links.push({ source: id, target, type: relationType })
        }
      }
    }
  }

  options?.onProgress?.(items.length, total)

  // Compute degree (total link count per node)
  for (const link of links) {
    const sourceNode = nodeMap.get(link.source)
    const targetNode = nodeMap.get(link.target)
    if (sourceNode) sourceNode.degree += 1
    if (targetNode) targetNode.degree += 1
  }

  return {
    nodes: [...nodeMap.values()],
    links,
  }
}
