import { sameProjectPath } from '#projects/identity.ts'
import type { Decision, HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { roleColumn } from '#tasks/column-rules.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HydraError } from '#store/errors.ts'
import { liveTask } from '#tasks/select.ts'
import type { Card } from '#tasks/model.ts'
import type { Blocker } from '#tasks/owner-gates.ts'
import { findSession } from './session-attachments.ts'
import { queueWorker, workerQueue } from './queue.ts'

function startedGap({ card }: { card: Card }): Blocker | undefined {
  if (card.sessionIds?.length) {
    return {
      reason: `${card.id} already has worker ${card.sessionIds.join(', ')}`,
      clear: `Reply to that worker with \`pnyx-axi reply ${card.id} --text "<message>"\`, or run \`pnyx-axi task detach ${card.id}\` first`,
    }
  }

  if (card.status?.state === 'done' || card.outcome) {
    return {
      reason: `${card.id} is finished`,
      clear: 'File a follow-up with `pnyx-axi task create`',
    }
  }

  if (card.copy?.state === 'active') {
    return {
      reason: `${card.id} has an active copy of its own`,
      clear: `Run \`pnyx-axi task copy ${card.id} remove --safe\` once its work has landed`,
    }
  }

  return undefined
}

export function queueAnchor({
  state,
  behind,
}: {
  state: HydraState
  behind: string
}): Card | undefined {
  return state.cards[behind] ?? state.cards[state.keys[behind] ?? '']
}

export function queueGap({
  state,
  task,
  behind,
}: {
  state: HydraState
  task: string
  behind: string
}): Blocker | undefined {
  const card = findCard({
    state,
    ref: task,
  })

  if (state.config?.hydra.kind === 'firstmate') {
    return {
      reason: 'Firstmate owns its worker assignments',
      clear: 'Ask Firstmate to queue this task',
    }
  }

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
      clear: `Run \`pnyx-axi task start ${card.id}\` to give it a worker`,
    }
  }

  const workerlessTask = anchor !== undefined && !anchor.queue && !anchor.sessionIds?.length
  const session = workerlessTask ? undefined : findSession({
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
      clear: `Run \`pnyx-axi task sessions\` for live workers, or start this task with \`pnyx-axi task start ${card.id}\``,
    }
  }

  if (!sameProjectPath({
    left: card.project,
    right: current.project,
  })) {
    return {
      reason: `queued tasks use the worker’s project: ${card.id} is in ${card.project ?? 'Ideas'}, ${current.id} in ${current.project ?? 'Ideas'}`,
      clear: `Run \`pnyx-axi task project ${card.id} --project <project>\` to match the worker’s project`,
    }
  }

  if (!roleColumn({
    columns: hydraConfig({ state }).columns,
    role: 'queued',
  })) {
    return {
      reason: 'the Hydra has no Queued column',
      clear: 'Restore a Queued column before queueing work',
    }
  }

  return undefined
}

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
  if (meta.id && Object.hasOwn(
    state.eventIds,
    meta.id,
  )) {
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

  let after = null
  let order: string[] | undefined

  if (behind !== undefined) {
    const gap = queueGap({
      state,
      task: card.id,
      behind,
    })

    if (gap) {
      throw new HydraError({
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
