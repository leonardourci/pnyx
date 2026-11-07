import { basename, dirname } from 'node:path'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { readThread, threadPath, type ThreadPage } from '#hydra/transcripts-read.ts'
import { paseoHistory } from '#integrations/paseo/history.ts'
import { paseoConversation, type PaseoConversation } from '#integrations/paseo/thread.ts'
import type { Card } from '#tasks/model.ts'
import { background } from './background.ts'
import type { createHost } from './host.ts'
import { LATEST_DELAY_MS } from './latest-feed.ts'
import type { HydraState } from './model.ts'
import type { HydraClient, ServerMessage } from './server-transport.ts'
import { watchPath, type PathWatch } from './watch.ts'

export type Subscription = {
  card: string
  path?: string
  paseo?: string
  watcher?: { close(): unknown }
  native?: Promise<PaseoConversation>
}

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
                    thread => {
                      if (map.get(ws) === sub && ws.readyState === ws.OPEN) {
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
                send({
                  ws,
                  message: {
                    type: 'thread',
                    thread: agents().thread({
                      card,
                      page: readThread({
                        hydraId,
                        state: state(),
                        card,
                        homes: homes(),
                      }),
                    }),
                  },
                })
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
  }: {
    sub: Subscription
    card: Card
    before?: string
  }): Promise<ThreadPage> => {
    const native = sub.native

    if (!native) {
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
