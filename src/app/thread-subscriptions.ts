import { HydraError } from '#store/errors.ts'
import { threadDelta, type ThreadDelta } from '#hydra/thread-delta.ts'
import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createHydraThreadView, hydraThreadView } from '#hydra/thread-view.ts'
import { joinLatest, mergeThreadPages, retainThreadPages, type ThreadBoundary } from '#hydra/thread-history.ts'
import { effectiveView } from '#settings/store.ts'
import { traces } from '#preferences/view.ts'
import { basename, dirname } from 'node:path'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { readThread, showsKind, threadAction, threadPath, type ThreadPage } from '#hydra/transcripts-read.ts'
import type { Card } from '#tasks/model.ts'
import { background } from './background.ts'
import { log } from './diagnostics.ts'
import type { createHost } from './host.ts'
import { LATEST_DELAY_MS } from './latest-feed.ts'
import type { EventType, HydraEvent, HydraState } from './model.ts'
import type { HydraClient, ServerMessage } from './server-transport.ts'
import { watchPath, type PathWatch } from './watch.ts'
import { createThreadDelivery } from './thread-delivery.ts'

export const LIVE_TEXT_DELAY_MS = 80

interface PreparedThread {
  thread: ThreadPage
  signature?: string
  delta?: ThreadDelta
}

export type Subscription = {
  card: string
  history?: ThreadPage
  base?: {
    signature: string
    page: ThreadPage
    project?: ReturnType<typeof createHydraThreadView>
  }
  client?: HydraClient
  restoring?: number
  refreshPending?: boolean
  view?: {
    id: string
    version: number
  }
  path?: string
  watcher?: { close(): unknown }
  // The card titles the Hydra thread was last built from.
  titles?: Record<string, string>
  // The last page the tab accepted, apart from the seq it was read at.
  sent?: string
  // The last page versioned for the tab, which the next delta is computed from.
  versioned?: ThreadPage
  readVersion?: number
}

// The events that can change what hydraThreadView shows: anything on Hydra's own card, its messages,
// operations and settings, the columns and view, the compactions and upgrades that hold messages,
// and a new title for a card it names.
export function changesHydraThread({
  event,
  sub,
  state,
}: {
  event: HydraEvent
  sub: Subscription
  state: HydraState
}): boolean {
  return event.cardId === HYDRA_CARD
    || threadAction({
      event,
      state,
    })
    || HYDRA_THREAD_PREFIXES.some(prefix => event.type.startsWith(prefix))
    || HYDRA_THREAD_EVENTS.includes(event.type)
    || state.cards[event.cardId]?.title !== sub.titles?.[event.cardId]
}

const HYDRA_THREAD_PREFIXES = [
  'hydra.',
  'board.',
]
const HYDRA_THREAD_EVENTS: readonly EventType[] = [
  'session.compaction',
  'pnyx.upgrade',
]

export function createThreadSubscriptions({
  hydraId,
  state,
  closed,
  send,
  agents,
}: {
  hydraId: string
  state(): HydraState
  closed(): boolean
  send({
    ws,
    message,
  }: {
    ws: HydraClient
    message: ServerMessage
  }): boolean
  agents(): Pick<ReturnType<typeof createHost>, 'thread'>
}) {
  const maps = new Map<string, Map<HydraClient, Subscription>>()

  const threadSubscriptions = () => {
    for (const [
      card,
      map,
    ] of maps) {
      if (!map.size) {
        maps.delete(card)
      }
    }

    return [...maps.values()]
  }

  const subscriptionMap = ({ card }: { card: string }) => {
    let map = maps.get(card)

    if (!map) {
      map = new Map<HydraClient, Subscription>()
      maps.set(
        card,
        map,
      )
    }

    return map
  }

  const threadTimers = new Map<HydraClient, ReturnType<typeof setTimeout>>()
  const liveThreadTimers = new Map<Subscription, ReturnType<typeof setTimeout>>()
  const liveSentAt = new WeakMap<Subscription, number>()
  const threadDelivery = createThreadDelivery({
    send,
    closed,
  })

  const deliver = ({
    ws,
    sub,
    prepared,
    receipt,
  }: {
    ws: HydraClient
    sub: Subscription
    prepared: PreparedThread
    receipt?: string
  }) => threadDelivery.push({
    key: sub,
    ws,
    thread: prepared.thread,
    delta: prepared.delta,
    receipt,
    current: () => subscriptionMap({ card: sub.card }).get(ws) === sub,
    accepted: () => {
      if (prepared.signature !== undefined && sub.versioned === prepared.thread) {
        sub.sent = prepared.signature
      }
    },
  })

  const shownRows = ({
    card,
    page,
  }: {
    card: Card
    page: ThreadPage
  }): ThreadPage => {
    const {
      tools,
      thinking,
    } = traces({
      view: effectiveView({ state: state() }),
      card: card.id,
    })

    return {
      ...page,
      entries: page.entries.filter(entry => showsKind({
        kind: entry.kind,
        tools,
        thinking,
      })),
    }
  }

  const prepareThread = ({
    sub,
    page,
    older = false,
    push = false,
    card,
  }: {
    sub: Subscription
    card: Card
    page: ThreadPage
    older?: boolean
    // A push the tab did not ask for is skipped when the page has not changed.
    push?: boolean
  }): PreparedThread | undefined => {
    sub.history = mergeThreadPages({
      before: sub.history ?? null,
      latest: page,
      olderPage: older,
    })
    let visible = sub.history

    if (older) {
      visible = agents().thread({
        card,
        page: {
          ...sub.history,
          entries: sub.history.entries.filter(entry => !entry.id.startsWith('live:')),
          currentTurn: undefined,
        },
      })
    }

    if (page.card !== HYDRA_CARD) {
      return versionThread({
        sub,
        prepared: shownRows({
          card,
          page: visible,
        }),
        push,
      })
    }

    const current = state()
    const {
      tools,
      thinking,
    } = traces({
      view: effectiveView({ state: current }),
      card: HYDRA_CARD,
    })
    const prepared = hydraThreadView({
      state: current,
      page: visible,
      tools,
      thinking,
    })

    return versionThread({
      sub,
      prepared,
      push,
    })
  }

  const versionThread = ({
    sub,
    prepared,
    push = false,
  }: {
    sub: Subscription
    prepared: ThreadPage
    push?: boolean
  }): PreparedThread | undefined => {
    const current = state()
    const sent = JSON.stringify(prepared.conversation ? {
      ...prepared,
      conversation: {
        ...prepared.conversation,
        through: 0,
      },
    } : prepared)

    if (push && sent === sub.sent && !threadDelivery.has({ key: sub })) {
      return undefined
    }

    if (prepared.card === HYDRA_CARD) {
      sub.titles = Object.fromEntries(Object.values(current.cards).map(card => [
        card.id,
        card.title,
      ]))
    }

    if (!sub.view) {
      sub.view = {
        id: randomUUID(),
        version: 0,
      }
    }

    const thread: ThreadPage = {
      ...prepared,
      stream: sub.view.id,
      version: ++sub.view.version,
    }

    if (thread.conversation) {
      thread.conversation = {
        ...thread.conversation,
        through: current.seq,
      }
    }

    // Only a push with nothing pending goes as a delta; a read is answered with a full page.
    const asDelta = push && sub.sent !== undefined && !threadDelivery.has({ key: sub })
    const delta = asDelta ? threadDelta({
      before: sub.versioned,
      after: thread,
    }) : undefined
    sub.versioned = thread

    return {
      signature: sent,
      thread,
      delta,
    }
  }

  const currentThread = ({
    sub,
    card,
  }: {
    sub: Subscription
    card: Card
  }) => {
    const path = threadPath({ card })
    let native = 'unavailable'

    if (path) {
      try {
        const stat = statSync(path)
        native = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      } catch { /* The missing transcript uses the saved event history. */ }
    }

    const signature = JSON.stringify({
      native,
      path,
      agent: card.agent,
    })

    if (!sub.base || sub.base.signature !== signature) {
      const page = readThread({
        hydraId,
        allTraces: true,
        state: state(),
        card,
      })

      sub.history = joinLatest({
        history: sub.history,
        latest: page,
        read: ({ before }) => readThread({
          hydraId,
          allTraces: true,
          state: state(),
          card,
          before,
        }),
      })

      if (card.id === HYDRA_CARD) {
        const selected = traces({
          view: effectiveView({ state: state() }),
          card: HYDRA_CARD,
        })
        sub.base = {
          signature,
          page,
          project: createHydraThreadView({
            state: state(),
            page: sub.history,
            ...selected,
          }),
        }
      } else {
        sub.base = {
          signature,
          page: shownRows({
            card,
            page: sub.history,
          }),
        }
      }
    }

    const page = agents().thread({
      card,
      page: sub.base.page,
    })

    return sub.base.project ? sub.base.project({ page }) : page
  }

  const refreshThread = ({
    ws,
    invalidate = true,
    resync = false,
  }: {
    ws: HydraClient
    invalidate?: boolean
    resync?: boolean
  }) => {
    if (invalidate || resync) {
      for (const map of threadSubscriptions()) {
        const sub = map.get(ws)

        if (sub) {
          sub.base = undefined

          if (resync) {
            sub.sent = undefined
            sub.versioned = undefined
          }
        }
      }
    }

    if (closed() || threadTimers.has(ws)) {
      return
    }

    threadTimers.set(
      ws,
      setTimeout(
        () => background({
          name: 'conversation refresh',
          run: () => {
            threadTimers.delete(ws)
            refreshThreadNow({ ws })
          },
        }),
        LATEST_DELAY_MS,
      ),
    )
  }

  const refreshThreadNow = ({
    ws,
    only,
  }: {
    ws: HydraClient
    only?: Subscription
  }) => {
    if (ws.readyState !== ws.OPEN) {
      return
    }

    for (const map of threadSubscriptions()) {
      const sub = map.get(ws), card = sub && state().cards[sub.card]

      if (!card || (only && sub !== only)) {
        continue
      }

      if (sub.restoring) {
        sub.refreshPending = true
        continue
      }

      const unavailable = () => send({
        ws,
        message: {
          type: 'error',
          id: null,
          code: 'THREAD_UNAVAILABLE',
          error: 'Conversation could not be refreshed',
        },
      })

      try {
        const building = performance.now()
        const base = sub.base
        const page = currentThread({
          sub,
          card,
        })
        const prepared = versionThread({
          sub,
          prepared: page,
          push: true,
        })

        if (prepared) {
          deliver({
            ws,
            sub,
            prepared,
          })
          // A page that kept its base only added live text: one line each while detailed logging is on.
          const live = sub.base !== undefined && sub.base === base
          // A rebuilt Hydra page's size comes from its signature, the page apart from its version fields;
          // a live update's is on its detailed socket.send line, so it is not measured twice.
          const signature = live ? undefined : prepared.signature
          log({
            operation: live ? 'thread.live' : 'thread.page',
            detailed: live,
            hydraId,
            taskId: card.id,
            count: prepared.thread.entries.length,
            bytes: signature === undefined ? undefined : Buffer.byteLength(signature),
            backlog: ws.bufferedAmount,
            ms: performance.now() - building,
          })
        }
      } catch {
        unavailable()
      }
    }
  }

  const refreshLiveThread = ({
    ws,
    card,
  }: {
    ws: HydraClient
    card: string
  }) => {
    const sub = subscriptionMap({ card }).get(ws)

    if (closed() || !sub || sub.card !== card || liveThreadTimers.has(sub)) {
      return
    }

    const last = liveSentAt.get(sub)
    const elapsed = last === undefined ? LIVE_TEXT_DELAY_MS : Date.now() - last

    const flush = () => {
      liveThreadTimers.delete(sub)
      liveSentAt.set(
        sub,
        Date.now(),
      )
      background({
        name: 'live conversation refresh',
        run: () => refreshThreadNow({
          ws,
          only: sub,
        }),
      })
    }

    if (elapsed >= LIVE_TEXT_DELAY_MS) {
      flush()

      return
    }

    liveThreadTimers.set(
      sub,
      setTimeout(
        flush,
        LIVE_TEXT_DELAY_MS - elapsed,
      ),
    )
  }

  const finishRead = ({
    sub,
    prepared,
    receipt,
  }: {
    sub: Subscription
    prepared: PreparedThread
    receipt?: string
  }) => {
    if (sub.client && (receipt !== undefined || threadDelivery.has({ key: sub }))) {
      deliver({
        ws: sub.client,
        sub,
        prepared,
        receipt,
      })
    }

    return prepared.thread
  }

  const threadPage = async ({
    sub,
    card,
    before,
    retain,
    receipt,
  }: {
    sub: Subscription
    card: Card
    before?: string
    retain?: ThreadBoundary
    receipt?: string
  }): Promise<ThreadPage> => {
    sub.base = undefined

    if (before || retain) {
      sub.readVersion = (sub.readVersion ?? 0) + 1
    }

    const version = sub.readVersion

    if (before === undefined && !retain) {
      const prepared = versionThread({
        sub,
        prepared: currentThread({
          sub,
          card,
        }),
      })!

      return finishRead({
        sub,
        prepared,
        receipt,
      })
    }

    const readPage = async ({ before }: { before?: string }): Promise<ThreadPage> => {
      const page = readThread({
        hydraId,
        allTraces: true,
        state: state(),
        card,
        before,
      })

      return before ? page : agents().thread({
        card,
        page,
      })
    }

    if (retain) {
      sub.restoring = (sub.restoring ?? 0) + 1
    }

    try {
      let page = await readPage({ before })

      if (retain && !before) {
        page = await retainThreadPages({
          page: mergeThreadPages({
            before: sub.history ?? null,
            latest: page,
          }),
          retain,
          read: readPage,
        })
      }

      if ((before || retain) && version !== sub.readVersion) {
        throw new HydraError({
          code: 'THREAD_SUPERSEDED',
          message: 'A newer conversation read replaced this one',
        })
      }

      sub.base = undefined
      const prepared = prepareThread({
        sub,
        card,
        page,
        older: before !== undefined,
      })!

      return finishRead({
        sub,
        prepared,
        receipt,
      })
    } finally {
      if (retain) {
        sub.restoring = (sub.restoring ?? 1) - 1

        if (!sub.restoring && sub.refreshPending && sub.client) {
          sub.refreshPending = false
          refreshThread({ ws: sub.client })
        }
      }
    }
  }

  const bindThread = ({
    ws,
    card,
  }: {
    ws: HydraClient
    card: Card
  }) => {
    const map = subscriptionMap({ card: card.id })
    const previous = map.get(ws)

    if (previous) {
      previous.watcher?.close()
      clearTimeout(liveThreadTimers.get(previous))
      liveThreadTimers.delete(previous)
      threadDelivery.cancel({ key: previous })
    }

    const path = threadPath({ card })
    const sub: Subscription = {
      card: card.id,
      client: ws,
      path,
    }

    if (path) {
      let file: PathWatch | undefined

      const followFile = () => {
        file?.close()
        file = undefined

        try {
          file = watchPath({
            path,
            changed: () => refreshThread({
              ws,
              invalidate: false,
            }),
          })
        } catch { /* The folder watcher retries when the transcript appears. */ }
      }

      try {
        const folder = watchPath({
          path: dirname(path),
          changed: ({ filename }) => {
            if (!filename || String(filename) === basename(path)) {
              followFile()
              refreshThread({
                ws,
                invalidate: false,
              })
            }
          },
        })
        sub.watcher = {
          close: () => {
            folder.close()
            file?.close()
          },
        }
        followFile()
      } catch { /* Missing transcript remains explicit. */ }
    }

    map.set(
      ws,
      sub,
    )
  }

  const retainThreads = ({
    ws,
    cards,
  }: {
    ws: HydraClient
    cards: string[]
  }) => {
    for (const map of threadSubscriptions()) {
      const sub = map.get(ws)

      if (!sub || sub.card === HYDRA_CARD || cards.includes(sub.card)) {
        continue
      }

      sub.watcher?.close()
      clearTimeout(liveThreadTimers.get(sub))
      liveThreadTimers.delete(sub)
      threadDelivery.cancel({ key: sub })
      map.delete(ws)
    }
  }

  return {
    threadSubscriptions,
    retainThreads,
    subscriptionMap,
    threadTimers,
    liveThreadTimers,
    threadDelivery,
    refreshLiveThread,
    refreshThread,
    threadPage,
    bindThread,
  }
}
