import { background } from './background.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { SOCKET_RETRY_MS, type HydraClient, type ServerMessage } from './server-transport.ts'

interface Delivery {
  ws: HydraClient
  thread?: ThreadPage
  current(): boolean
  accepted(): void
  receipts: Set<string>
  timer?: ReturnType<typeof setTimeout>
}

export function createThreadDelivery({
  send,
  closed,
}: {
  send({
    ws,
    message,
  }: {
    ws: HydraClient
    message: ServerMessage
  }): boolean
  closed(): boolean
}) {
  const pending = new Map<object, Delivery>()
  // A detached scope can leave its physical socket open while an old read finishes.
  const closedClients = new WeakSet<HydraClient>()

  const remove = ({ key }: { key: object }) => {
    clearTimeout(pending.get(key)?.timer)
    pending.delete(key)
  }

  const attempt = ({ key }: { key: object }) => {
    const delivery = pending.get(key)

    if (!delivery) {
      return
    }

    if (closed() || delivery.ws.readyState !== delivery.ws.OPEN) {
      remove({ key })

      return
    }

    if (!delivery.current()) {
      delivery.thread = undefined
    }

    if (!delivery.thread && !delivery.receipts.size) {
      remove({ key })

      return
    }

    let accepted = true

    if (delivery.receipts.size) {
      for (const id of delivery.receipts) {
        let message: ServerMessage = {
          type: 'error',
          id,
          code: 'THREAD_CANCELLED',
          error: 'Conversation read cancelled because its subscription changed',
        }

        if (delivery.thread) {
          message = {
            type: 'receipt',
            id,
            thread: delivery.thread,
          }
        }

        accepted = send({
          ws: delivery.ws,
          message,
        })

        if (!accepted) {
          break
        }

        delivery.receipts.delete(id)
      }
    } else if (delivery.thread) {
      accepted = send({
        ws: delivery.ws,
        message: {
          type: 'thread',
          thread: delivery.thread,
        },
      })
    }

    if (accepted) {
      remove({ key })

      if (delivery.thread) {
        delivery.accepted()
      }

      return
    }

    delivery.timer = setTimeout(
      () => background({
        name: 'conversation delivery',
        run: () => attempt({ key }),
      }),
      SOCKET_RETRY_MS,
    )
    delivery.timer.unref()
  }

  return {
    push({
      key,
      receipt,
      ...delivery
    }: Omit<Delivery, 'receipts' | 'timer'> & {
      key: object
      receipt?: string
    }) {
      if (closedClients.has(delivery.ws)) {
        return
      }

      const receipts = pending.get(key)?.receipts ?? new Set<string>()

      if (receipt !== undefined) {
        receipts.add(receipt)
      }

      remove({ key })
      pending.set(
        key,
        {
          ...delivery,
          receipts,
        },
      )
      attempt({ key })
    },
    has({ key }: { key: object }) {
      return pending.has(key)
    },
    cancel({ key }: { key: object }) {
      const delivery = pending.get(key)

      if (delivery) {
        clearTimeout(delivery.timer)
        delivery.thread = undefined
        attempt({ key })
      }
    },
    remove,
    removeClient({ ws }: { ws: HydraClient }) {
      closedClients.add(ws)

      for (const [
        key,
        delivery,
      ] of pending) {
        if (delivery.ws === ws) {
          remove({ key })
        }
      }
    },
    close() {
      for (const key of pending.keys()) {
        remove({ key })
      }
    },
  }
}
