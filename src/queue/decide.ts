import { sameProjectPath } from '../projects/identity.ts'
import { requireUnheld } from '../core/holds.ts'
import type { Decision, HydraState } from '../app/model.ts'
import type { Meta } from '../app/command-meta.ts'
import { findCard } from '../core/decide.ts'
import { roleColumn } from '../tasks/column-rules.ts'
import { hydraConfig, hydraEvent } from '../core/hydra.ts'
import { HydraError } from '../store/errors.ts'
import { findSession, liveTask } from '../core/tasks.ts'
import { queueWorker, workerQueue } from './state.ts'

export function decideQueue({
  state,
  task,
  behind,
  meta,
}: {
  state: HydraState
  task: string
  behind?: string
  meta: Meta
}): Decision {
  if (meta.id && meta.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  const card = findCard({
    state,
    ref: task,
  })

  if (!liveTask({ card }) || card.id === '$hydra') {
    throw new HydraError({
      message: 'choose a visible task',
      code: 'VALIDATION_ERROR',
    })
  }

  if (state.config?.hydra.kind === 'firstmate') {
    throw new HydraError({
      message: 'Firstmate owns its worker assignments; ask it to queue this task',
      code: 'CONFLICT',
    })
  }

  let after = null
  let order: string[] | undefined

  if (behind !== undefined) {
    requireUnheld({ card })

    if (card.sessionIds?.length || card.status?.state === 'done' || card.outcome || card.copy?.state === 'active') {
      throw new HydraError({
        message: 'queue only an unstarted task without an active copy',
        code: 'CONFLICT',
      })
    }

    const anchor = state.cards[behind] ?? state.cards[state.keys[behind] ?? '']

    if (anchor?.id === card.id) {
      throw new HydraError({
        message: 'a task cannot queue behind itself',
        code: 'CONFLICT',
      })
    }

    const session = findSession({
      state,
      ref: anchor?.queue?.session ?? behind,
    })
    const current = queueWorker({
      state,
      session,
    })

    if (!current) {
      throw new HydraError({
        message: 'queue behind a live task worker',
        code: 'CONFLICT',
      })
    }

    if (!sameProjectPath({
      left: card.project,
      right: current.project,
    })) {
      throw new HydraError({
        message: 'queued tasks must use the worker’s project',
        code: 'CONFLICT',
      })
    }

    const queue = workerQueue({
      state,
      session: session.id,
    }).filter(c => c.id !== card.id)
    const index = anchor?.queue ? queue.findIndex(c => c.id === anchor.id) + 1 : queue.length
    order = queue.map(c => c.id)
    order.splice(
      index,
      0,
      card.id,
    )
    after = {
      session: session.id,
      rank: index + 1,
    }
  }

  if (!card.queue && !after) {
    return { skipped: 'unchanged' }
  }

  const column = roleColumn({
    columns: hydraConfig({ state }).columns,
    role: 'queued',
  })

  if (!column) {
    throw new HydraError({
      message: 'restore a Queued column before queueing work',
      code: 'CONFLICT',
    })
  }

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.queue',
      data: {
        before: card.queue ?? null,
        after,
        ...(order ? { order } : {}),
        column,
      },
    },
  })
}
