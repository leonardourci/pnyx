import { THREAD_CURSOR } from '#hydra/transcripts-read.ts'
import { PASEO_HISTORY_CURSOR } from '#integrations/paseo/history.ts'
import { HydraError } from '#store/errors.ts'
import { findCard } from '#tasks/push-rules.ts'
import type { HydraState } from '#app/model.ts'
import type { createThreadSubscriptions } from '#app/thread-subscriptions.ts'
import type { CommandRequest } from './dispatch.ts'

type ThreadSubscriptions = ReturnType<typeof createThreadSubscriptions>

// `thread [<card> [<cursor>]]`: follows a card's conversation in the tab and sends its first or an older page.
export function threadCommand({
  ws,
  id,
  args,
  fail,
  send,
  state,
  subscriptionMap,
  bindThread,
  threadPage,
}: CommandRequest & {
  state(): HydraState
  subscriptionMap: ThreadSubscriptions['subscriptionMap']
  bindThread: ThreadSubscriptions['bindThread']
  threadPage: ThreadSubscriptions['threadPage']
}) {
  const map = subscriptionMap({ card: args[0] ?? '' })
  const old = map.get(ws)

  const unbind = () => {
    old?.watcher?.close()
    map.delete(ws)
  }

  if (!args[0]) {
    unbind()
    send({
      ws,
      message: {
        type: 'receipt',
        id,
      },
    })

    return
  }

  const card = findCard({
    state: state(),
    ref: args[0],
  })

  const cursor = card.agent?.paseoAgentId ? PASEO_HISTORY_CURSOR : THREAD_CURSOR
  const cursorLimit = card.agent?.paseoAgentId ? 600 : 200

  if (args[1] !== undefined && (args[1].length > cursorLimit || !cursor.test(args[1]))) {
    throw new HydraError({
      message: 'invalid thread cursor',
      code: 'VALIDATION_ERROR',
    })
  }

  // Loading earlier history keeps the subscription, and with it the history already loaded.
  if (!args[1] || old?.card !== card.id) {
    unbind()
    bindThread({
      ws,
      card,
    })
  }

  const sub = map.get(ws)!
  void threadPage({
    sub,
    card,
    before: args[1],
  }).then(
    thread => {
      if (ws.readyState === ws.OPEN) {
        send({
          ws,
          message: {
            type: 'receipt',
            id,
            thread,
          },
        })
      }
    },
    (error: Error) => fail({
      error: error.message,
      code: error instanceof HydraError ? error.code : 'UNKNOWN',
    }),
  )
}
