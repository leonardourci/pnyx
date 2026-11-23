import { asRecord, invalid } from '#app/command-validation.ts'
import type { ThreadBoundary } from '#titan/thread-history.ts'
import { THREAD_CURSOR, threadPath } from '#titan/transcripts-read.ts'
import { TitanError } from '#store/errors.ts'
import { findCard } from '#tasks/push-rules.ts'
import type { TitanState } from '#app/model.ts'
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

export function threadCommand({
  ws,
  id,
  args,
  fail,
  send,
  state,
  subscriptionMap,
  retainThreads,
  bindThread,
  threadPage,
}: CommandRequest & {
  state(): TitanState
  subscriptionMap: ThreadSubscriptions['subscriptionMap']
  retainThreads: ThreadSubscriptions['retainThreads']
  bindThread: ThreadSubscriptions['bindThread']
  threadPage: ThreadSubscriptions['threadPage']
}) {
  if (!args[0]) {
    // Without a card the tab stops following its task conversations; Titan's own stays.
    retainThreads({
      ws,
      cards: [],
    })
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
  const map = subscriptionMap({ card: card.id })
  const old = map.get(ws)
  const restoring = args[1] === '--retain'
  const retain = restoring ? retainedBoundary({ value: args[2] }) : undefined
  const cursorGiven = args[1] !== undefined && !args[1].startsWith('--')
  const before = cursorGiven ? args[1] : undefined

  if (before !== undefined && (before.length > 200 || !THREAD_CURSOR.test(before))) {
    throw new TitanError({
      message: 'invalid thread cursor',
      code: 'VALIDATION_ERROR',
    })
  }

  const sameThread = old !== undefined && old.card === card.id
    && old.path === threadPath({ card })

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
          receipt: id,
        })
      } catch (error) {
        fail({
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof TitanError ? error.code : 'UNKNOWN',
        })
      }
    },
  })
}
