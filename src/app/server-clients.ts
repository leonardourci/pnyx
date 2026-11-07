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
import { MAX_BUFFERED, type HydraClient, type ServerMessage } from './server-transport.ts'
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
  refreshThread({ ws }: { ws: HydraClient }): void
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

  const resyncing = new WeakSet<HydraClient>()

  const send = ({
    ws,
    message,
  }: {
    ws: HydraClient
    message: ServerMessage
  }) => {
    if (ws.bufferedAmount > MAX_BUFFERED) {
      resyncing.add(ws)

      return
    }

    if (ws.readyState === ws.OPEN) {
      ws.send({ message })
    }
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
    resyncing.delete(ws)
    send({
      ws,
      message: {
        type: 'snapshot',
        seq: state().seq,
        state: state(),
      },
    })
    ws.send({
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

    sendQueue({
      ws,
      queue,
    })

    if (hydraSubscribers.has(ws)) {
      ws.send({
        message: {
          type: 'hydras',
          hydraId,
          hydras: listHydras(),
        },
      })
    }
  }

  // ponytail: a lagging tab gets its snapshot on the next change, not when its buffer drains.
  const broadcast = ({ event }: { event: HydraEvent }) => {
    const queue = queueMessage()

    for (const ws of clients) {
      if (!resyncing.has(ws)) {
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
      } else if (ws.bufferedAmount <= MAX_BUFFERED) {
        sendSnapshot({
          ws,
          queue,
        })
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
    get spendNow() {
      return spendNow
    },
    get readingsNow() {
      return readingsNow
    },
  }
}
