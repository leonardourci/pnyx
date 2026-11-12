import { asRecord, invalid } from '#app/command-validation.ts'
import type { ThreadBoundary } from '#hydra/thread-history.ts'
import { THREAD_CURSOR, threadPath } from '#hydra/transcripts-read.ts'
import { PASEO_HISTORY_CURSOR } from '#integrations/paseo/history.ts'
import { HydraError } from '#store/errors.ts'
import { findCard } from '#tasks/push-rules.ts'
import type { HydraState } from '#app/model.ts'
import type { createThreadSubscriptions } from '#app/thread-subscriptions.ts'
import type { CommandRequest } from './dispatch.ts'
import { background } from '#app/background.ts'

type ThreadSubscriptions = ReturnType<typeof createThreadSubscriptions>

const MAX_BOUNDARY_LENGTH = 2048

function retainedBoundary({ value }: { value?: string }): ThreadBoundary {
  if (!value || value.length > MAX_BOUNDARY_LENGTH) {
    throw invalid({ message: 'invalid retained conversation boundary' })
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch {
    throw invalid({ message: 'invalid retained conversation boundary' })
  }

  const boundary = asRecord({ value: parsed })

  if (!boundary || typeof boundary.oldest !== 'string' || !boundary.oldest
    || (boundary.session !== undefined && typeof boundary.session !== 'string')) {
    throw invalid({ message: 'invalid retained conversation boundary' })
  }

  return {
    oldest: boundary.oldest,
    session: boundary.session,
  }
}

// thread follows a card; --retain restores the range identified by its session and oldest entry.
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

  const recent = args[1] === '--recent'
  const restoring = args[1] === '--retain'
  const retain = restoring ? retainedBoundary({ value: args[2] }) : undefined
  const before = restoring || recent ? undefined : args[1]
  const cursor = card.agent?.paseoAgentId ? PASEO_HISTORY_CURSOR : THREAD_CURSOR
  const cursorLimit = card.agent?.paseoAgentId ? 600 : 200

  if (before !== undefined && (before.length > cursorLimit || !cursor.test(before))) {
    throw new HydraError({
      message: 'invalid thread cursor',
      code: 'VALIDATION_ERROR',
    })
  }

  const sameThread = old !== undefined && old.card === card.id
    && old.path === threadPath({ card }) && old.paseo === card.agent?.paseoAgentId

  if (!sameThread) {
    bindThread({
      ws,
      card,
    })
  }

  const sub = map.get(ws)!
  background({
    name: 'conversation read',
    run: async () => {
      try {
        await threadPage({
          sub,
          card,
          before,
          retain,
          recent,
          receipt: id,
        })
      } catch (error) {
        fail({
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof HydraError ? error.code : 'UNKNOWN',
        })
      }
    },
  })
}
