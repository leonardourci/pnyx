import { connectHost, type HostClient } from '#agent-host/client.ts'
import type { ToClient } from '#agent-host/protocol.ts'
import { fail } from '#agent-host/protocol.ts'

const RECONNECT_MS = 250

export async function nativeConnection({
  socket,
  installation,
  token,
  capabilities,
  attached,
  reconnect,
}: {
  socket: string
  installation: string
  token: string
  capabilities: string[]
  reconnect?(): Promise<void>
  attached({ client }: { client: HostClient }): Promise<void>
}) {
  const readers = new Set<({ frame }: { frame: ToClient }) => void>()
  const disconnects = new Set<() => void>()
  let current: HostClient
  let available = false, stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const connect = async () => {
    const establish = () => connectHost({
      socket,
      installation,
      token,
      capabilities,
    })

    let next: HostClient

    try {
      next = await establish()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if (!reconnect || code !== 'ENOENT' && code !== 'ECONNREFUSED') {
        throw error
      }

      if (stopped) {
        return
      }

      await reconnect()

      if (stopped) {
        return
      }

      next = await establish()
    }

    const unwatchStatus = next.subscribe({
      receive: ({ frame }) => {
        if (frame.type === 'host-status') {
          next.ready.readiness = frame.status
        }
      },
    })

    try {
      await attached({ client: next })
    } catch (error) {
      next.detach()
      throw error
    } finally {
      unwatchStatus()
    }

    if (stopped) {
      next.detach()

      return
    }

    current = next
    available = true
    next.subscribe({
      receive: ({ frame }) => {
        for (const receive of readers) {
          receive({ frame })
        }
      },
    })
    next.onDisconnect({
      receive: () => {
        if (current !== next) {
          return
        }

        available = false

        for (const receive of disconnects) {
          receive()
        }

        schedule()
      },
    })

    for (const receive of readers) {
      receive({ frame: next.ready })
    }
  }

  const schedule = () => {
    if (stopped || timer) {
      return
    }

    timer = setTimeout(
      async () => {
        timer = undefined

        // Reconnect only the transport; an ambiguous mutation is never retried here.
        try {
          await connect()
        } catch (error) {
          console.error(
            'Native host reconnect failed:',
            error,
          )
          schedule()
        }
      },
      RECONNECT_MS,
    ).unref()
  }

  const live = () => {
    if (!available) {
      fail({
        code: 'DISCONNECTED',
        message: 'Wait for native inventory reconciliation before another action',
      })
    }

    return current
  }

  await connect()
  const client: HostClient & { available(): boolean } = {
    get ready() {
      return current.ready
    },
    available: () => available,
    call: ({ ...request }) => live().call(request),
    result: ({ ...request }) => live().result(request),
    acknowledge: ({ ...request }) => live().acknowledge(request),
    watch: ({ ...request }) => live().watch(request),
    subscribe({ receive }) {
      readers.add(receive)

      return () => readers.delete(receive)
    },
    onDisconnect({ receive }) {
      disconnects.add(receive)

      return () => disconnects.delete(receive)
    },
    detach() {
      stopped = true
      clearTimeout(timer)
      current.detach()
    },
  }

  return client
}
