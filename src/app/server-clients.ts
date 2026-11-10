import { hydraChatQueue } from '#hydra/chat-queue.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { threadPath, type LatestMessage } from '#hydra/transcripts-read.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { traces } from '#preferences/view.ts'
import { effectiveView, readSettings } from '#settings/store.ts'
import type { Card } from '#tasks/model.ts'
import type { AgentUsage } from '#workers/provider.ts'
import { spendCounter } from '#workers/spend-counter.ts'
import { spendInputs, type TaskSpend } from '#workers/task-spend.ts'
import { readEvents } from './event-log.ts'
import type { createHost } from './host.ts'
import type { HydraEvent, HydraState } from './model.ts'
import { listHydras } from './server-hydras.ts'
import { MAX_BUFFERED, SOCKET_RETRY_MS, type HydraClient, type ServerMessage } from './server-transport.ts'
import { background } from './background.ts'
import { log } from './diagnostics.ts'
import { changesHydraThread, type Subscription } from './thread-subscriptions.ts'

const shownTraces = ({
  view,
  card,
}: {
  view: ViewPreferences
  card: string
}) => {
  const {
    tools,
    thinking,
  } = traces({
    view: effectiveView({ state: { view } }),
    card,
  })

  return `${tools}:${thinking}`
}

// The tabs connected to one mounted Hydra and everything pushed to them: events, snapshots, spend, settings and resumes.
export function createServerClients({
  hydraId,
  state,
  recent,
  agents,
  threadSubscriptions,
  bindThread,
  refreshThread,
  feed,
}: {
  hydraId: string
  state(): HydraState
  recent(): HydraEvent[]
  agents(): Pick<ReturnType<typeof createHost>, 'queue' | 'usageViews'>
  threadSubscriptions: Map<HydraClient, Subscription>[]
  bindThread({
    ws,
    card,
  }: {
    ws: HydraClient
    card: Card
  }): void
  refreshThread({
    ws,
    resync,
  }: {
    ws: HydraClient
    resync?: boolean
  }): void
  feed(): {
    latest: Record<string, LatestMessage>
    actions: Record<string, CurrentAction>
  }
}) {
  const clients = new Set<HydraClient>()
  const hydraSubscribers = new WeakSet<HydraClient>()

  let derivedThrough = -1
  let derivedHistory: HydraEvent[] = []

  const derivationEvents = () => {
    if (state().seq !== derivedThrough) {
      derivedHistory = readEvents({ hydraId })
      derivedThrough = state().seq
    }

    return derivedHistory
  }

  type Latest = Extract<ServerMessage, { type: 'latest' }>
  interface Pending {
    snapshot: boolean
    latest?: Latest
    queue?: Extract<ServerMessage, { type: 'hydraQueue' }>
    timer?: ReturnType<typeof setTimeout>
    // When the tab's socket filled up, for how long it stayed held.
    since: number
  }
  const recovery = new Map<HydraClient, Pending>()
  const closedClients = new WeakSet<HydraClient>()

  const mergeLatest = ({
    before,
    latest,
  }: {
    before?: Latest
    latest: Latest
  }): Latest => {
    const previous = before ?? {
      type: 'latest',
      messages: {},
      actions: {},
    }

    return {
      ...previous,
      ...latest,
      messages: {
        ...previous.messages,
        ...latest.messages,
      },
      actions: {
        ...previous.actions,
        ...latest.actions,
      },
    }
  }

  const clearRecovery = ({ ws }: { ws: HydraClient }) => {
    const pending = recovery.get(ws)

    if (!pending) {
      return
    }

    clearTimeout(pending.timer)
    recovery.delete(ws)
    log({
      operation: 'socket.drained',
      hydraId,
      backlog: ws.bufferedAmount,
      ms: performance.now() - pending.since,
    })
  }

  const retry = ({ ws }: { ws: HydraClient }) => {
    const pending = recovery.get(ws)

    if (pending && !pending.timer) {
      pending.timer = setTimeout(
        () => background({
          name: 'socket recovery',
          run: () => flush({ ws }),
        }),
        SOCKET_RETRY_MS,
      )
      pending.timer.unref()
    }
  }

  const defer = ({
    ws,
    message,
  }: {
    ws: HydraClient
    message: ServerMessage
  }) => {
    const held = recovery.get(ws)
    const pending: Pending = held ?? {
      snapshot: false,
      since: performance.now(),
    }

    if (!held) {
      log({
        level: 'warn',
        operation: 'socket.held',
        hydraId,
        name: message.type,
        backlog: ws.bufferedAmount,
      })
    }

    if (message.type === 'event' || message.type === 'snapshot' || message.type === 'hydras') {
      pending.snapshot = true
    } else if (message.type === 'latest') {
      pending.latest = mergeLatest({
        before: pending.latest,
        latest: message,
      })
    } else if (message.type === 'hydraQueue') {
      pending.queue = message
    } else {
      return
    }

    recovery.set(
      ws,
      pending,
    )
    retry({ ws })
  }

  const send = ({
    ws,
    message,
  }: {
    ws: HydraClient
    message: ServerMessage
  }): boolean => {
    if (closedClients.has(ws) || ws.readyState !== ws.OPEN) {
      return false
    }

    if (ws.bufferedAmount > MAX_BUFFERED) {
      defer({
        ws,
        message,
      })

      return false
    }

    const pending = recovery.get(ws)

    if (message.type === 'latest' && pending?.latest) {
      message = mergeLatest({
        before: pending.latest,
        latest: message,
      })
    }

    ws.send({ message })

    if (pending) {
      if (message.type === 'latest') {
        delete pending.latest
      }

      if (message.type === 'hydraQueue') {
        delete pending.queue
      }

      if (!pending.snapshot && !pending.latest && !pending.queue) {
        clearRecovery({ ws })
      }
    }

    return true
  }

  const queueMessage = (): ServerMessage => {
    const queued = agents().queue()
    const chat = hydraChatQueue({ state: state() })

    // The batch Hydra reads shows only while its turn runs.
    return {
      type: 'hydraQueue',
      queue: {
        waiting: queued.waiting,
        reading: chat.working ? queued.reading : [],
        chat,
      },
    }
  }

  const sendQueue = ({
    ws,
    queue = queueMessage(),
  }: {
    ws: HydraClient
    queue?: ServerMessage
  }) => send({
    ws,
    message: queue,
  })

  const sendSnapshot = ({
    ws,
    queue,
  }: {
    ws: HydraClient
    queue?: ServerMessage
  }) => {
    const pending = recovery.get(ws)
    const accepted = send({
      ws,
      message: {
        type: 'snapshot',
        seq: state().seq,
        state: state(),
      },
    })

    if (!accepted) {
      return false
    }

    const latest = mergeLatest({
      before: {
        type: 'latest',
        ...spendNow,
        usage: agents().usageViews({
          spend: spendNow.spend,
          readings: readingsNow,
        }),
        messages: feed().latest,
        actions: feed().actions,
      },
      latest: pending?.latest ?? {
        type: 'latest',
        messages: {},
        actions: {},
      },
    })
    clearRecovery({ ws })
    // Once accepted, the snapshot and its current facts form one recovery batch.
    ws.send({ message: latest })
    ws.send({ message: queue ?? queueMessage() })

    if (hydraSubscribers.has(ws)) {
      ws.send({
        message: {
          type: 'hydras',
          hydraId,
          hydras: listHydras(),
        },
      })
    }

    return true
  }

  const flush = ({ ws }: { ws: HydraClient }) => {
    const pending = recovery.get(ws)

    if (!pending) {
      return
    }

    clearTimeout(pending.timer)
    pending.timer = undefined

    if (closedClients.has(ws) || ws.readyState !== ws.OPEN) {
      clearRecovery({ ws })

      return
    }

    if (ws.bufferedAmount > MAX_BUFFERED) {
      retry({ ws })

      return
    }

    if (pending.snapshot) {
      if (sendSnapshot({ ws })) {
        refreshThread({
          ws,
          resync: true,
        })
      }

      return
    }

    if (pending.latest) {
      send({
        ws,
        message: pending.latest,
      })
    }

    if (pending.queue) {
      send({
        ws,
        message: pending.queue,
      })
    }

    retry({ ws })
  }

  const broadcast = ({ event }: { event: HydraEvent }) => {
    const queue = queueMessage()

    for (const ws of clients) {
      if (!recovery.get(ws)?.snapshot) {
        send({
          ws,
          message: {
            type: 'event',
            event,
          },
        })
        sendQueue({
          ws,
          queue,
        })
      } else {
        flush({ ws })
      }

      for (const map of threadSubscriptions) {
        const sub = map.get(ws)

        // A view change that switches this card's traces on or off changes its page.
        if (sub && ((sub.card === HYDRA_CARD && changesHydraThread({
          event,
          sub,
          state: state(),
        })) || sub.card === event.cardId
        || (event.type === 'task.session' && sub.card === event.data.before)
        || (event.type === 'board.view' &&
          shownTraces({
            view: event.data.before,
            card: sub.card,
          })
          !== shownTraces({
            view: event.data.after,
            card: sub.card,
          })))) {
          const card = state().cards[sub.card]

          if (card && (sub.path !== threadPath({ card })
            || sub.paseo !== card.agent?.paseoAgentId)) {
            bindThread({
              ws,
              card,
            })
          }

          refreshThread({ ws })
        }
      }
    }
  }

  // Task tokens, counted off the event loop; tabs get them once the first count is in.
  let readingsNow: Record<string, import('#workers/provider.ts').UsageReading> = {}
  let usageNow: Record<string, AgentUsage> = {}
  let spendNow: { spend?: Record<string, TaskSpend> } = {}
  const spend = spendCounter({
    inputs: () => spendInputs({
      state: state(),
      events: derivationEvents(),
    }),
    onSpend: ({
      spend,
      readings,
    }) => {
      readingsNow = readings
      const usage = agents().usageViews({
        spend,
        readings,
      })

      if (JSON.stringify(spend) === JSON.stringify(spendNow.spend)
        && JSON.stringify(usage) === JSON.stringify(usageNow)) {
        return
      }

      spendNow = { spend }
      usageNow = usage

      for (const ws of clients) {
        send({
          ws,
          message: {
            type: 'latest',
            spend,
            usage,
            messages: {},
            actions: {},
          },
        })
      }
    },
  })

  const sendSettings = ({ ws }: { ws: HydraClient }) => {
    const read = readSettings()
    send({
      ws,
      message: {
        type: 'settings',
        settings: read.settings,
        revision: read.revision,
      },
    })
  }

  // A cursor this server can continue from gets only the events after it; any
  // other cursor (ahead of the Hydra, older than the kept events, or none) gets a snapshot.
  // Either way the tab then gets every card's last message.
  const resume = ({
    ws,
    after,
  }: {
    ws: HydraClient
    after: string | null
  }) => {
    const seq = after !== null && /^\d+$/.test(after) ? Number(after) : undefined
    const first = recent()[0]?.seq ?? state().seq + 1

    if (seq === undefined || seq > state().seq || seq < first - 1) {
      return sendSnapshot({ ws })
    }

    for (const event of recent()) {
      if (event.seq > seq) {
        send({
          ws,
          message: {
            type: 'event',
            event,
          },
        })
      }
    }

    sendQueue({ ws })
    send({
      ws,
      message: {
        type: 'latest',
        ...spendNow,
        usage: agents().usageViews({
          spend: spendNow.spend,
          readings: readingsNow,
        }),
        messages: feed().latest,
        actions: feed().actions,
      },
    })
  }

  return {
    clients,
    hydraSubscribers,
    send,
    queueMessage,
    sendQueue,
    sendSnapshot,
    broadcast,
    spend,
    sendSettings,
    resume,
    closeClient({ ws }: { ws: HydraClient }) {
      closedClients.add(ws)
      clearRecovery({ ws })
    },
    close() {
      for (const ws of recovery.keys()) {
        clearRecovery({ ws })
      }
    },
    get spendNow() {
      return spendNow
    },
    get readingsNow() {
      return readingsNow
    },
  }
}
