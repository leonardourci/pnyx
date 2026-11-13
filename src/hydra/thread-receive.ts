import type { ServerMessage } from '#app/server-transport.ts'
import { HYDRA_CARD } from './identity.ts'
import { applyThreadDelta, receivedThread } from './thread-delta.ts'
import type { ThreadPage } from './transcripts-read.ts'

export function createThreadReceiver() {
  let hydra: ThreadPage | null = null
  let worker: ThreadPage | null = null

  const read = ({ card }: { card: string }) => {
    if (card === HYDRA_CARD) {
      return hydra
    }

    return worker?.card === card ? worker : null
  }

  return {
    read,
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

      if (thread.card === HYDRA_CARD) {
        hydra = thread
      } else {
        worker = thread
      }

      return {
        ...incoming,
        thread,
      }
    },
  }
}
