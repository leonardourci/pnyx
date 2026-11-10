import { background } from './background.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import type { HydraClient, ServerMessage } from './server-transport.ts'

export const THREAD_RETRY_MS = 100

interface Delivery {
  ws: HydraClient
  thread: ThreadPage
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

  const remove = ({ key }: { key: object }) => {
    clearTimeout(pending.get(key)?.timer)
    pending.delete(key)
  }

  const attempt = ({ key }: { key: object }) => {
    const delivery = pending.get(key)

    if (!delivery) {
      return
    }

    if (closed() || !delivery.current() || delivery.ws.readyState !== delivery.ws.OPEN) {
      remove({ key })

      return
    }

    let accepted = true

    if (delivery.receipts.size) {
      for (const id of delivery.receipts) {
        accepted = send({
          ws: delivery.ws,
          message: {
            type: 'receipt',
            id,
            thread: delivery.thread,
          },
        })

        if (!accepted) {
          break
        }

        delivery.receipts.delete(id)
      }
    } else {
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
      delivery.accepted()

      return
    }

    delivery.timer = setTimeout(
      () => background({
        name: 'conversation delivery',
        run: () => attempt({ key }),
      }),
      THREAD_RETRY_MS,
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
    remove,
    close() {
      for (const key of pending.keys()) {
        remove({ key })
      }
    },
  }
}
