import { randomUUID } from 'node:crypto'
import { hydraThreadView } from '#hydra/thread-view.ts'
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

export type Subscription = {
  card: string
  history?: ThreadPage
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
  }): void
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
  }): ThreadPage | undefined => {
    if (page.card !== HYDRA_CARD) {
      return page
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

    const sent = JSON.stringify({
      ...prepared,
      conversation: {
        ...prepared.conversation,
        through: 0,
      },
    })

    if (push && sent === sub.sent) {
      return undefined
    }

    sub.sent = sent
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
      ...prepared,
      conversation: {
        ...prepared.conversation,
        stream: sub.view.id,
        version: ++sub.view.version,
      },
    }
  }

  const refreshThread = ({ ws }: { ws: HydraClient }) => {
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

            if (ws.readyState !== ws.OPEN) {
              return
            }

            for (const map of threadSubscriptions) {
              const sub = map.get(ws), card = sub && state().cards[sub.card]

              if (!card) {
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

                      const thread = prepareThread({
                        sub,
                        page,
                        push: true,
                      })

                      if (thread) {
                        send({
                          ws,
                          message: {
                            type: 'thread',
                            thread,
                          },
                        })
                      }
                    },
                    unavailable,
                  ),
                })

                continue
              }

              try {
                const thread = prepareThread({
                  sub,
                  page: agents().thread({
                    card,
                    page: readThread({
                      hydraId,
                      state: state(),
                      card,
                      homes: homes(),
                    }),
                  }),
                  push: true,
                })

                if (thread) {
                  send({
                    ws,
                    message: {
                      type: 'thread',
                      thread,
                    },
                  })
                }
              } catch {
                unavailable()
              }
            }
          },
        }),
        LATEST_DELAY_MS,
      ),
    )
  }

  const threadPage = async ({
    sub,
    card,
    before,
    retain,
  }: {
    sub: Subscription
    card: Card
    before?: string
    retain?: ThreadBoundary
  }): Promise<ThreadPage> => {
    const native = sub.native

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

      return prepareThread({
        sub,
        page,
        older: before !== undefined,
      })!
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
    map.get(ws)?.watcher?.close()
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
        changed: () => refreshThread({ ws }),
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
            changed: () => refreshThread({ ws }),
          })
        } catch { /* The folder watcher retries when the transcript appears. */ }
      }

      try {
        const folder = watchPath({
          path: dirname(path),
          changed: ({ filename }) => {
            if (!filename || String(filename) === basename(path)) {
              followFile()
              refreshThread({ ws })
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
    refreshThread,
    threadPage,
    bindThread,
  }
}
