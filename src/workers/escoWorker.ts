/// <reference lib="webworker" />

import * as jsonld from 'jsonld'
import { transformFlattened } from '../graph/escoGraph'
import type { WorkerIncomingMessage, WorkerOutgoingMessage } from '../graph/types'

let cancelled = false

const postWorkerMessage = (message: WorkerOutgoingMessage): void => {
  self.postMessage(message)
}

self.onmessage = async (event: MessageEvent<WorkerIncomingMessage>) => {
  const message = event.data

  if (message.type === 'cancel') {
    cancelled = true
    return
  }

  if (message.type !== 'process') {
    return
  }

  cancelled = false

  try {
    const flattened = await jsonld.flatten(message.payload as object)

    const graph = transformFlattened(flattened, {
      chunkSize: message.chunkSize,
      isCancelled: () => cancelled,
      onChunk: (chunk) => {
        postWorkerMessage({
          type: 'chunk',
          payload: chunk,
        })
      },
    })

    if (!cancelled) {
      postWorkerMessage({
        type: 'complete',
        payload: {
          totalNodes: graph.nodes.length,
          totalLinks: graph.links.length,
        },
      })
    }
  } catch (error) {
    postWorkerMessage({
      type: 'error',
      payload: error instanceof Error ? error.message : 'Unknown worker error',
    })
  }
}

export {}
