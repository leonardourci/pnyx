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
      if (message.type === 'thread.delta') {
        const before = read({ card: message.delta.page.card })
        const thread = applyThreadDelta({
          before,
          delta: message.delta,
        })

        if (!thread) {
          return undefined
        }

        message = {
          ...message,
          type: 'thread',
          thread,
        }
      }

      let incoming: ThreadPage | undefined

      if (message.type === 'thread') {
        incoming = message.thread
      } else if (message.type === 'receipt') {
        incoming = message.thread
      }

      if (incoming) {
        const thread = receivedThread({
          before: read({ card: incoming.card }),
          latest: incoming,
        })

        if (thread.card === HYDRA_CARD) {
          hydra = thread
        } else {
          worker = thread
        }

        if (message.type === 'thread' || message.type === 'receipt') {
          message = {
            ...message,
            thread,
          }
        }
      }

      return message
    },
  }
}
