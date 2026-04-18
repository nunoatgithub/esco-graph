/// <reference lib="webworker" />

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
    postWorkerMessage({ type: 'progress', payload: { processed: 0, total: 1 } })
    const parsed = JSON.parse(message.payload) as unknown

    if (!Array.isArray(parsed)) {
      throw new Error('Expected a pre-flattened JSON array. Run flatten.sh first.')
    }

    const graph = transformFlattened(parsed, {
      isCancelled: () => cancelled,
      onProgress: (processed, total) => {
        postWorkerMessage({ type: 'progress', payload: { processed, total } })
      },
    })

    if (!cancelled) {
      postWorkerMessage({ type: 'complete', payload: graph })
    }
  } catch (error) {
    postWorkerMessage({
      type: 'error',
      payload: error instanceof Error ? error.message : 'Unknown worker error',
    })
  }
}

export {}
