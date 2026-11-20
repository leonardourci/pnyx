import { sameProjectPath } from '#projects/identity.ts'
import { requireUnheld } from '#tasks/holds.ts'
import type { Decision, HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { roleColumn } from '#tasks/column-rules.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HydraError } from '#store/errors.ts'
import { liveTask } from '#tasks/select.ts'
import type { Card } from '#tasks/model.ts'
import { findSession } from './session-attachments.ts'
import { queueWorker, workerQueue } from './queue.ts'

function requireUnstarted({ card }: { card: Card }): void {
  const refuse = ({
    why,
    clear,
  }: {
    why: string
    clear: string
  }) => {
    throw new HydraError({
      message: `queue only an unstarted task without an active copy: ${card.id} ${why}`,
      code: 'CONFLICT',
      help: [clear],
    })
  }

  if (card.sessionIds?.length) {
    refuse({
      why: `has worker ${card.sessionIds.join(', ')}`,
      clear: `Run \`pnyx-axi task detach ${card.id}\` first, or reply to its worker`,
    })
  }

  if (card.status?.state === 'done' || card.outcome) {
    refuse({
      why: 'is finished',
      clear: 'File a follow-up with `pnyx-axi task intake` instead',
    })
  }

  if (card.copy?.state === 'active') {
    refuse({
      why: 'has an active copy',
      clear: `Run \`pnyx-axi task copy ${card.id} remove --safe\` once its work has landed`,
    })
  }
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

    requireUnstarted({ card })

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
        message: `${behind} has no live task worker to queue behind`,
        code: 'CONFLICT',
        help: [`Run \`pnyx-axi task sessions\` for live workers, or start this task with \`pnyx-axi task start ${card.id}\``],
      })
    }

    if (!sameProjectPath({
      left: card.project,
      right: current.project,
    })) {
      throw new HydraError({
        message: `queued tasks must use the worker’s project: ${card.id} is in ${card.project ?? 'Ideas'}, ${current.id} in ${current.project ?? 'Ideas'}`,
        code: 'CONFLICT',
        help: [`Run \`pnyx-axi task project ${card.id} --project <project>\` to match the worker’s project`],
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
