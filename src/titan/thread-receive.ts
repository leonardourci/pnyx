import type { ServerMessage } from '#app/server-transport.ts'
import { TITAN_CARD } from './identity.ts'
import { applyThreadDelta, receivedThread } from './thread-delta.ts'
import type { ThreadPage } from './transcripts-read.ts'

// The worker chats updated last keep their page after they close, so one opened again shows at once while its read
// refreshes it.
const CLOSED_THREADS_KEPT = 8

export function createThreadReceiver() {
  let titan: ThreadPage | null = null
  const workers = new Map<string, ThreadPage>()

  const read = ({ card }: { card: string }) => {
    if (card === TITAN_CARD) {
      return titan
    }

    return workers.get(card) ?? null
  }

  return {
    read,
    // Every worker page held, open or kept after closing, by card id.
    workers: () => Object.fromEntries(workers),
    retain({ cards }: { cards: string[] }) {
      const closed = [...workers.keys()].filter(id => !cards.includes(id))

      const dropped = closed.slice(
        0,
        -CLOSED_THREADS_KEPT,
      )

      for (const id of dropped) {
        workers.delete(id)
      }
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
        // Setting a key again keeps its place in the map, so it moves to the end as the newest.
        workers.delete(thread.card)
        workers.set(
          thread.card,
          thread,
        )
      }

      return {
        ...incoming,
        thread,
      }
    },
  }
}
