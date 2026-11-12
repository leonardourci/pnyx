import { HydraError } from '#store/errors.ts'
import { threadDelta, type ThreadDelta } from '#hydra/thread-delta.ts'
import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createHydraThreadView, hydraThreadView } from '#hydra/thread-view.ts'
import { mergeThreadPages, nextRecentCursor, pageCount, retainThreadPages, recentThreadPages, threadSize, RECENT_THREAD_ENTRIES, THREAD_PAGE_LIMIT, type ThreadBoundary } from '#hydra/thread-history.ts'
import { effectiveView } from '#settings/store.ts'
import { traces } from '#preferences/view.ts'
import { basename, dirname } from 'node:path'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { readThread, threadAction, threadPath, type ThreadPage } from '#hydra/transcripts-read.ts'
import { paseoHistory } from '#integrations/paseo/history.ts'
import { paseoConversation, type PaseoConversation } from '#integrations/paseo/thread.ts'
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
  paseo?: string
  watcher?: { close(): unknown }
  native?: Promise<PaseoConversation>
  // The card titles the Hydra thread was last built from.
  titles?: Record<string, string>
  // The last page the tab accepted, apart from the seq it was read at.
  sent?: string
  // The last page versioned for the tab, which the next delta is computed from.
  versioned?: ThreadPage
  // Whether Hydra's window keeps only its recent pages, how many entries its last reset kept, and a count of
  // explicit reads, so a read or refresh that a newer read overtook is dropped.
  recent?: boolean
  recentLimit?: number
  readVersion?: number
}

// A recent window resets once arrivals have grown it a page past what its last reset kept,
// so each reset rereads the recent pages once per page of arrivals, not on every one.
function overRecentLimit({
  sub,
  page,
}: {
  sub: Subscription
  page: ThreadPage
}): boolean {
  const limit = (sub.recentLimit ?? RECENT_THREAD_ENTRIES) + THREAD_PAGE_LIMIT

  return sub.recent === true && threadSize({ page }) > limit
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
  'chat.message',
  'session.compaction',
  'pnyx.upgrade',
]

// Each tab's open conversation page: the transcript or Paseo conversation it follows and the debounced refresh it gets.
export function createThreadSubscriptions({
  hydraId,
  state,
  homes,
  closed,
  send,
  agents,
}: {
  hydraId: string
  state(): HydraState
  homes(): string[]
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
  const subscriptions = new Map<HydraClient, Subscription>()
  const hydraSubscriptions = new Map<HydraClient, Subscription>()
  const threadSubscriptions = [
    subscriptions,
    hydraSubscriptions,
  ]
  const subscriptionMap = ({ card }: { card: string }) =>
    card === HYDRA_CARD ? hydraSubscriptions : subscriptions
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
    if (page.card !== HYDRA_CARD) {
      return versionThread({
        sub,
        prepared: page,
        push,
      })
    }

    const current = state()
    sub.history = mergeThreadPages({
      before: sub.history ?? null,
      latest: page,
      olderPage: older,
    })

    const {
      tools,
      thinking,
    } = traces({
      view: effectiveView({ state: current }),
      card: HYDRA_CARD,
    })
    let visible = sub.history

    if (older && !sub.native) {
      visible = agents().thread({
        card,
        page: {
          ...sub.history,
          entries: sub.history.entries.filter(entry => !entry.id.startsWith('live:')),
          currentTurn: undefined,
        },
      })
    }

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
      pages: pageCount({ page: prepared }),
      recent: sub.recent === true,
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
      homes: homes(),
    })

    if (!sub.base || sub.base.signature !== signature) {
      const page = readThread({
        hydraId,
        state: state(),
        card,
        homes: homes(),
      })

      if (card.id === HYDRA_CARD) {
        sub.history = mergeThreadPages({
          before: sub.history ?? null,
          latest: page,
        })

        if (overRecentLimit({
          sub,
          page: sub.history,
        })) {
          let recent = page
          const seen = new Set<string>()

          let cursor = nextRecentCursor({
            page: recent,
            seen,
          })

          while (cursor) {
            recent = mergeThreadPages({
              before: recent,
              latest: readThread({
                hydraId,
                state: state(),
                card,
                homes: homes(),
                before: cursor,
              }),
              olderPage: true,
            })
            cursor = nextRecentCursor({
              page: recent,
              seen,
            })
          }

          sub.history = recent
          sub.recentLimit = threadSize({ page: recent })
        }
      }

      const selected = traces({
        view: effectiveView({ state: state() }),
        card: HYDRA_CARD,
      })
      sub.base = {
        signature,
        page,
        project: card.id === HYDRA_CARD ? createHydraThreadView({
          state: state(),
          page: sub.history!,
          ...selected,
        }) : undefined,
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
      for (const map of threadSubscriptions) {
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

    for (const map of threadSubscriptions) {
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

      if (sub.native) {
        const native = sub.native
        const version = sub.readVersion
        background({
          name: 'native conversation refresh',
          run: async () => {
            try {
              const read = ({ before }: { before?: string }) => paseoHistory({
                card: card.id,
                conversation: { read: async ({ before }) => (await native).read({ before }) },
                readSaved: ({ before }) => readThread({
                  hydraId,
                  state: state(),
                  card,
                  homes: homes(),
                  before,
                }),
                before,
              })
              let page = await read({})
              const merged = mergeThreadPages({
                before: sub.history ?? null,
                latest: page,
              })
              const recent = overRecentLimit({
                sub,
                page: merged,
              })

              if (recent) {
                page = await recentThreadPages({
                  page,
                  read,
                })
              }

              if (map.get(ws) !== sub || ws.readyState !== ws.OPEN || version !== sub.readVersion) {
                return
              }

              if (recent) {
                sub.history = undefined
                sub.recentLimit = threadSize({ page })
              }

              const prepared = prepareThread({
                sub,
                card,
                page,
                push: true,
              })

              if (prepared) {
                deliver({
                  ws,
                  sub,
                  prepared,
                })
              }
            } catch {
              unavailable()
            }
          },
        })
        continue
      }

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
    recent = false,
    receipt,
  }: {
    sub: Subscription
    card: Card
    before?: string
    retain?: ThreadBoundary
    recent?: boolean
    receipt?: string
  }): Promise<ThreadPage> => {
    sub.base = undefined

    if (recent || before || retain) {
      sub.readVersion = (sub.readVersion ?? 0) + 1
    }

    const version = sub.readVersion

    if (recent) {
      sub.recent = true
    } else if (before || retain) {
      sub.recent = false
    }

    const native = sub.native

    if (!native && before === undefined && !retain && !recent) {
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
      if (native) {
        return paseoHistory({
          card: card.id,
          conversation: { read: async ({ before }) => (await native).read({ before }) },
          readSaved: ({ before }) => readThread({
            hydraId,
            state: state(),
            card,
            homes: homes(),
            before,
          }),
          before,
        })
      }

      const page = readThread({
        hydraId,
        state: state(),
        card,
        homes: homes(),
        before,
      })

      return before ? page : agents().thread({
        card,
        page,
      })
    }

    if (retain || recent) {
      sub.restoring = (sub.restoring ?? 0) + 1
    }

    try {
      let page = await readPage({ before })

      if (recent) {
        page = await recentThreadPages({
          page,
          read: readPage,
        })
      }

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

      if ((recent || before || retain) && version !== sub.readVersion) {
        throw new HydraError({
          code: 'THREAD_SUPERSEDED',
          message: 'A newer conversation read replaced this one',
        })
      }

      if (recent) {
        sub.history = undefined
        sub.versioned = undefined
        sub.sent = undefined
        sub.recentLimit = threadSize({ page })
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
      if (retain || recent) {
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
    const paseo = card.agent?.paseoAgentId

    if (paseo) {
      const native = paseoConversation({
        card,
        changed: () => refreshThread({
          ws,
          invalidate: false,
        }),
      })
      native.catch(() => undefined)
      const watcher = {
        close: () => void native.then(
          n => n.close(),
          () => undefined,
        ),
      }
      Object.assign(
        sub,
        {
          paseo,
          native,
          watcher,
        },
      )
    } else if (path) {
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

  return {
    threadSubscriptions,
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
