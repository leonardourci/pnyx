import { sameProjectPath } from '#projects/identity.ts'
import { inform } from '#app/command-notices.ts'
import type { Decision, TitanState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { completedOutcome } from '#tasks/dependencies.ts'
import { hydraEvent } from '#titan/titan.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { TitanError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import type { Blocker } from '#tasks/owner-gates.ts'
import { findSession, sessionByRef } from './session-attachments.ts'
import { queueWorker, workerQueue } from './queue.ts'

function startedGap({ card }: { card: Card }): Blocker | undefined {
  if (card.sessionIds?.length) {
    return {
      reason: `${card.id} already has worker ${card.sessionIds.join(', ')}`,
      clear: `Reply with \`othrys send --task ${card.id} --text "<message>"\` or detach the worker in the UI`,
    }
  }

  if (card.workerLog?.status?.code === 'done' || completedOutcome({ outcome: card.outcome })) {
    return {
      reason: `${card.id} is finished`,
      clear: 'File a follow-up with `othrys task create`',
    }
  }

  if (card.copy?.state === 'active') {
    return {
      reason: `${card.id} has an active copy of its own`,
      clear: `Review the copy of task ${card.id} in the UI once its work has landed.`,
    }
  }

  return undefined
}

function visibleTask({
  state,
  task,
}: {
  state: TitanState
  task: string
}): Card {
  const card = findCard({
    state,
    ref: task,
  })

  if (card.id === TITAN_CARD) {
    throw new TitanError({
      message: 'choose a visible task',
      code: 'VALIDATION_ERROR',
    })
  }

  if (card.hidden) {
    inform({
      task: card.id,
      reason: 'Queue changed for a hidden task',
      clear: `Review the visibility of task ${card.id} in the UI.`,
    })
  }

  return card
}

export function queueAnchor({
  state,
  behind,
}: {
  state: TitanState
  behind: string
}): Card | undefined {
  return state.cards[behind] ?? state.cards[state.keys[behind] ?? '']
}

export function queueGap({
  state,
  task,
  behind,
}: {
  state: TitanState
  task: string
  behind: string
}): Blocker | undefined {
  const card = visibleTask({
    state,
    task,
  })

  const started = startedGap({ card })

  if (started) {
    return started
  }

  const anchor = queueAnchor({
    state,
    behind,
  })

  if (anchor?.id === card.id) {
    return {
      reason: 'a task cannot queue behind itself',
      clear: `Send a message to task ${card.id} from the UI to start its worker.`,
    }
  }

  const workerlessTask = anchor !== undefined && !anchor.queue && !anchor.sessionIds?.length
  const session = workerlessTask ? undefined : sessionByRef({
    state,
    ref: anchor?.queue?.session ?? behind,
  })
  const current = session && queueWorker({
    state,
    session,
  })

  if (!current) {
    return {
      reason: `${behind} has no live task worker to queue behind`,
      clear: 'Read task.log session records for live workers, or send this task a message from the UI.',
    }
  }

  if (!current.project) {
    return {
      reason: `queued tasks use the worker’s project, and ${current.id} is in Ideas`,
      clear: 'Queue it behind a worker on an attached project; task.log session records lists live workers',
    }
  }

  if (!sameProjectPath({
    left: card.project,
    right: current.project,
  })) {
    return {
      reason: `queued tasks use the worker’s project: ${card.id} is in ${card.project ?? 'Ideas'}, ${current.id} in ${current.project}`,
      clear: `Review the project of task ${card.id} in the UI.`,
    }
  }

  return undefined
}

export function queueRequestGap({
  state,
  card,
  reorder,
  behind,
}: {
  state: TitanState
  card: Card
  reorder: boolean
  behind?: string
}): Blocker | undefined {
  if (reorder && !card.queue) {
    return {
      reason: `${card.id} is not queued`,
      clear: `Review the queue for task ${card.id} in the UI.`,
    }
  }

  if (behind === undefined) {
    return undefined
  }

  return queueGap({
    state,
    task: card.id,
    behind,
  })
}

export function decideQueue({
  state,
  task,
  behind,
  meta,
}: {
  state: TitanState
  task: string
  behind?: string
  meta: Meta
}): Decision {
  if (meta.id && Object.hasOwn(
    state.eventIds,
    meta.id,
  )) {
    return { skipped: 'duplicate' }
  }

  const card = visibleTask({
    state,
    task,
  })

  let after = null
  let order: string[] | undefined

  if (behind !== undefined) {
    const gap = queueGap({
      state,
      task: card.id,
      behind,
    })

    if (gap) {
      throw new TitanError({
        message: gap.reason,
        code: 'CONFLICT',
        help: [gap.clear],
      })
    }

    const anchor = queueAnchor({
      state,
      behind,
    })
    const session = findSession({
      state,
      ref: anchor?.queue?.session ?? behind,
    })
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
      },
    },
  })
}
