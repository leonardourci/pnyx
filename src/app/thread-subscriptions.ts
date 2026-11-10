import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createHydraThreadView, hydraThreadView } from '#hydra/thread-view.ts'
import { mergeThreadPages, retainThreadPages, type ThreadBoundary } from '#hydra/thread-history.ts'
import { effectiveView } from '#settings/store.ts'
import { traces } from '#preferences/view.ts'
import { basename, dirname } from 'node:path'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { readThread, threadPath, type ThreadPage } from '#hydra/transcripts-read.ts'
import { paseoHistory } from '#integrations/paseo/history.ts'
import { paseoConversation, type PaseoConversation } from '#integrations/paseo/thread.ts'
import type { Card } from '#tasks/model.ts'
import { background } from './background.ts'
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
  // The Hydra thread last sent: its card titles, and the page apart from the seq it was read at.
  titles?: Record<string, string>
  sent?: string
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
    receipt,
    current: () => subscriptionMap({ card: sub.card }).get(ws) === sub,
    accepted: () => {
      if (prepared.signature !== undefined) {
        sub.sent = prepared.signature
      }
    },
  })

  const prepareThread = ({
    sub,
    page,
    older = false,
    push = false,
  }: {
    sub: Subscription
    page: ThreadPage
    older?: boolean
    // A push the tab did not ask for is skipped when the page has not changed.
    push?: boolean
  }): PreparedThread | undefined => {
    if (page.card !== HYDRA_CARD) {
      return { thread: page }
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
    const prepared = hydraThreadView({
      state: current,
      page: sub.history,
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
    if (!prepared.conversation) {
      return { thread: prepared }
    }

    const current = state()
    const sent = JSON.stringify({
      ...prepared,
      conversation: {
        ...prepared.conversation,
        through: 0,
      },
    })

    if (push && sent === sub.sent && !threadDelivery.has({ key: sub })) {
      return undefined
    }

    sub.titles = Object.fromEntries(Object.values(current.cards).map(card => [
      card.id,
      card.title,
    ]))

    if (!sub.view) {
      sub.view = {
        id: randomUUID(),
        version: 0,
      }
    }

    return {
      signature: sent,
      thread: {
        ...prepared,
        conversation: {
          ...prepared.conversation,
          through: current.seq,
          stream: sub.view.id,
          version: ++sub.view.version,
        },
      },
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
        background({
          name: 'native conversation refresh',
          run: () => paseoHistory({
            card: card.id,
            conversation: { read: async ({ before }) => (await native).read({ before }) },
            readSaved: ({ before }) => readThread({
              hydraId,
              state: state(),
              card,
              homes: homes(),
              before,
            }),
          }).then(
            page => {
              if (map.get(ws) !== sub || ws.readyState !== ws.OPEN) {
                return
              }

              const prepared = prepareThread({
                sub,
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
            },
            unavailable,
          ),
        })

        continue
      }

      try {
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
    const native = sub.native

    if (!native && before === undefined && !retain) {
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

      sub.base = undefined
      const prepared = prepareThread({
        sub,
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
