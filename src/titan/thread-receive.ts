import type { ServerMessage } from '#app/server-transport.ts'
import { TITAN_CARD } from './identity.ts'
import { applyThreadDelta, receivedThread } from './thread-delta.ts'
import type { ThreadPage } from './transcripts-read.ts'

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
    retain({ cards }: { cards: string[] }) {
      for (const id of workers.keys()) {
        if (!cards.includes(id)) {
          workers.delete(id)
        }
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
