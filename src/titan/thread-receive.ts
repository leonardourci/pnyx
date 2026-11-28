import type { ServerMessage } from '#app/server-transport.ts'
import { TITAN_CARD } from './identity.ts'
import { applyThreadDelta, receivedThread } from './thread-delta.ts'
import type { ThreadPage } from './transcripts-read.ts'

const CLOSED_THREADS_KEPT = 8

export function createThreadReceiver() {
  let titan: ThreadPage | null = null
  const workers = new Map<string, ThreadPage>()
  let openCards = new Set<string>()

  const trimClosedPages = () => {
    const closedOldestFirst = [...workers.keys()].filter(id => !openCards.has(id))
    const dropped = closedOldestFirst.slice(
      0,
      -CLOSED_THREADS_KEPT,
    )

    for (const id of dropped) {
      workers.delete(id)
    }
  }

  const read = ({ card }: { card: string }) => {
    if (card === TITAN_CARD) {
      return titan
    }

    return workers.get(card) ?? null
  }

  return {
    read,
    workerPages: () => Object.fromEntries(workers),
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
        workers.delete(thread.card)
        workers.set(
          thread.card,
          thread,
        )
        trimClosedPages()
      }

      return {
        ...incoming,
        thread,
      }
    },
  }
}
