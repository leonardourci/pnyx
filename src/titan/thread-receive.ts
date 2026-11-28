import type { ServerMessage } from '#app/server-transport.ts'
import { TITAN_CARD } from './identity.ts'
import { applyThreadDelta, receivedThread } from './thread-delta.ts'
import type { ThreadPage } from './transcripts-read.ts'

const CLOSED_THREADS_KEPT = 8

export function createThreadReceiver() {
  let titan: ThreadPage | null = null
  const updatedWorkers = new Set<string>()
  let workerPages: Record<string, ThreadPage> = {}
  let openCards = new Set<string>()

  const trimClosedPages = () => {
    const closedOldestFirst = [...updatedWorkers].filter(id => !openCards.has(id))
    const dropped = closedOldestFirst.slice(
      0,
      -CLOSED_THREADS_KEPT,
    )

    if (!dropped.length) {
      return
    }

    workerPages = { ...workerPages }

    for (const id of dropped) {
      updatedWorkers.delete(id)
      delete workerPages[id]
    }
  }

  const read = ({ card }: { card: string }) => {
    if (card === TITAN_CARD) {
      return titan
    }

    if (!Object.hasOwn(
      workerPages,
      card,
    )) {
      return null
    }

    return workerPages[card] ?? null
  }

  return {
    read,
    workerPages: () => workerPages,
    retain({ cards }: { cards: string[] }) {
      openCards = new Set(cards)
      trimClosedPages()
    },
    receive({ message }: { message: ServerMessage }): ServerMessage | undefined {
      let incoming = message

      if (message.type === 'thread.delta') {
        const thread = applyThreadDelta({
          before: read({ card: message.delta.page.card }),
          delta: message.delta,
        })

        if (!thread) {
          return undefined
        }

        incoming = {
          ...message,
          type: 'thread',
          thread,
        }
      }

      if ((incoming.type !== 'thread' && incoming.type !== 'receipt') || !incoming.thread) {
        return incoming
      }

      const thread = receivedThread({
        before: read({ card: incoming.thread.card }),
        latest: incoming.thread,
      })

      if (thread.card === TITAN_CARD) {
        titan = thread
      } else {
        updatedWorkers.delete(thread.card)
        updatedWorkers.add(thread.card)
        workerPages = {
          ...workerPages,
          [thread.card]: thread,
        }
        trimClosedPages()
      }

      return {
        ...incoming,
        thread,
      }
    },
  }
}
