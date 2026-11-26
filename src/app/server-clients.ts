import { pageShows, type PageInterest } from './page-state.ts'
import { hydraChatQueue } from '#titan/chat-queue.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import type { CurrentAction } from '#titan/calls.ts'
import { threadPath, type LatestMessage } from '#titan/transcripts-read.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { traces } from '#preferences/view.ts'
import { effectiveView } from '#settings/store.ts'
import type { Card } from '#tasks/model.ts'
import { liveTask } from '#tasks/select.ts'
import type { AgentUsage } from '#workers/provider.ts'
import { spendCounter } from '#workers/spend-counter.ts'
import { spendInputs, type TaskSpend } from '#workers/task-spend.ts'
import { scanEvents } from './event-log.ts'
import type { createHost } from './host.ts'
import type { TitanEvent, TitanState } from './model.ts'
import type { TitanClient, ServerMessage } from './server-transport.ts'
import { changesTitanThread, type Subscription } from './thread-subscriptions.ts'

// A tab that opened no cards and did not ask for hidden ones.
const NO_INTEREST: PageInterest = {
  cards: [],
  hidden: false,
}

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

export function createServerClients({
  titanId,
  state,
  agents,
  threadSubscriptions,
  bindThread,
  refreshThread,
  feed,
}: {
  titanId: string
  state(): TitanState
  agents(): Pick<ReturnType<typeof createHost>, 'queue' | 'usageViews'>
  threadSubscriptions(): Map<TitanClient, Subscription>[]
  bindThread({
    ws,
    card,
  }: {
    ws: TitanClient
    card: Card
  }): void
  refreshThread({ ws }: { ws: TitanClient }): void
  feed(): {
    latest: Record<string, LatestMessage>
    actions: Record<string, CurrentAction>
  }
}) {
  const clients = new Set<TitanClient>()
  const interests = new WeakMap<TitanClient, PageInterest>()
  const interestFor = ({ ws }: { ws: TitanClient }) => interests.get(ws) ?? NO_INTEREST
  const liveCardIds = () => new Set(Object.values(state().cards).filter(card => liveTask({ card }))
    .map(card => card.id))
  // The cards a tab shows without interests, so a card an event brings back gets its cached latest.
  let liveCards = liveCardIds()
  // A card the previous state did not hold is new, not brought back, so it has no cached latest to send.
  let knownCards = new Set(Object.keys(state().cards))

  const shownWithoutInterest = ({ id }: { id: string }) => {
    const card = state().cards[id]

    return card !== undefined && pageShows({
      card,
      interest: NO_INTEREST,
    })
  }

  type Latest = Extract<ServerMessage, { type: 'latest' }>
  const closedClients = new WeakSet<TitanClient>()

  const visibleLatest = ({
    ws,
    message,
  }: {
    ws: TitanClient
    message: Latest
  }): Latest => {
    const interest = interestFor({ ws })
    const visible = <Value>({ values }: { values: Record<string, Value> }) =>
      Object.fromEntries(Object.entries(values).filter(([
        id,
        value,
      ]) => {
        const card = state().cards[id]

        return value === null || card !== undefined && pageShows({
          card,
          interest,
        })
      }))

    return {
      ...message,
      messages: visible({ values: message.messages }),
      actions: visible({ values: message.actions }),
      spend: visible({ values: message.spend ?? {} }),
      usage: visible({ values: message.usage ?? {} }),
    }
  }

  const send = ({
    ws,
    message,
    snapshot,
  }: {
    ws: TitanClient
    message: ServerMessage
    snapshot?: boolean
  }): boolean => {
    if (closedClients.has(ws) || ws.readyState !== ws.OPEN) {
      return false
    }

    if (message.type === 'latest') {
      message = visibleLatest({
        ws,
        message,
      })
    }

    return ws.send({
      message,
      snapshot,
    })
  }

  const queue = () => {
    const queued = agents().queue()
    const chat = hydraChatQueue({ state: state() })

    return {
      waiting: queued.waiting,
      reading: chat.working ? queued.reading : [],
      chat,
    }
  }

  // Every card's latest message, action, spend and usage the tab may see, as one batch.
  const sendLatest = ({ ws }: { ws: TitanClient }) => send({
    ws,
    snapshot: true,
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

  const broadcast = ({ event }: { event: TitanEvent }) => {
    const live = liveCardIds()
    const returned = [...live].filter(id => knownCards.has(id) && !liveCards.has(id))
    liveCards = live
    knownCards = new Set(Object.keys(state().cards))
    // Titan taking a task message is filed under Titan's card but changes that task's thread.
    const receivedTask = event.type === 'titan.received'
      ? state().hydraMessages?.find(message => message.id === event.data.message)?.task
      : undefined

    for (const ws of clients) {
      if (returned.length) {
        send({
          ws,
          message: {
            type: 'latest',
            ...spendNow,
            usage: agents().usageViews({
              spend: spendNow.spend,
              readings: readingsNow,
            }),
            messages: Object.fromEntries(returned.map(id => [
              id,
              feed().latest[id] ?? null,
            ])),
            actions: Object.fromEntries(returned.map(id => [
              id,
              feed().actions[id] ?? null,
            ])),
          },
        })
      }

      for (const map of threadSubscriptions()) {
        const sub = map.get(ws)

        // A view change that switches this card's traces on or off changes its page.
        if (sub && ((sub.card === TITAN_CARD && changesTitanThread({
          event,
          sub,
          state: state(),
        })) || sub.card === event.cardId || sub.card === receivedTask
        || (event.type === 'task.session' && sub.card === event.data.before)
        || (event.type === 'titan.view' &&
          shownTraces({
            view: event.data.before,
            card: sub.card,
          })
          !== shownTraces({
            view: event.data.after,
            card: sub.card,
          })))) {
          const card = state().cards[sub.card]

          if (card && sub.path !== threadPath({ card })) {
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
      events: scanEvents({
        titanId,
        types: [
          'titan.configured',
          'task.session',
        ],
      }),
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

  return {
    clients,
    send,
    queue,
    sendLatest,
    // A tab that names its cards when it subscribes gets its first latest batch already scoped.
    open({
      ws,
      interest,
    }: {
      ws: TitanClient
      interest: PageInterest
    }) {
      interests.set(
        ws,
        interest,
      )
    },
    show({
      ws,
      interest,
    }: {
      ws: TitanClient
      interest: PageInterest
    }) {
      const before = interestFor({ ws })
      interests.set(
        ws,
        interest,
      )
      // Only an added or released card the tab would not show anyway changes what it holds.
      const toggled = ({ id }: { id: string }) =>
        before.cards.includes(id) !== interest.cards.includes(id)
      const changed = before.hidden !== interest.hidden || (!interest.hidden && [
        ...before.cards,
        ...interest.cards,
      ].some(id => toggled({ id }) && !shownWithoutInterest({ id })))

      if (changed) {
        sendLatest({ ws })
      }
    },
    broadcast,
    spend,
    closeClient({ ws }: { ws: TitanClient }) {
      closedClients.add(ws)
    },
    close() {
      clients.forEach(ws => closedClients.add(ws))
    },
    get spendNow() {
      return spendNow
    },
    get readingsNow() {
      return readingsNow
    },
  }
}
