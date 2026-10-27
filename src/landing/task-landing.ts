import { commit, required, type Output } from '../cli/commands.ts'
import type { Meta } from '../app/command-meta.ts'
import { findCard } from '../core/decide.ts'
import { hydraEvent, reportActor } from '../core/hydra.ts'
import type { HydraState } from '../app/model.ts'
import { HydraError, type LandingRule } from '../core/model.ts'
import { loadHydra } from '../app/store.ts'
import { parseLanding, parseMerger, taskLanding } from './rule.ts'

// Only the owner, or Hydra on the owner's word, gives one task a rule other than its project's.
export function decideTaskLanding({
  state,
  ref,
  landing,
  merge,
  clear,
  meta,
}: {
  state: HydraState
  ref: string
  landing?: string
  merge?: string
  clear: boolean
  meta: Meta
}) {
  const card = findCard({
    state,
    ref,
  })

  if (reportActor({ actor: meta.actor })) {
    throw new HydraError({
      message: 'only the owner, or Hydra on the owner\'s word, changes how a task lands',
      code: 'FORBIDDEN',
    })
  }

  let after: LandingRule | null = null

  if (!clear) {
    const current = taskLanding({
      state,
      card,
    })

    if (!current) {
      throw new HydraError({
        message: `task ${card.id} has no project; give it one with \`task rename ${card.id} --project <name>\` first`,
        code: 'CONFLICT',
      })
    }

    after = {
      landing: landing === undefined ? current.landing : parseLanding({ value: landing }),
      merge: merge === undefined ? current.merge : parseMerger({ value: merge }),
    }
  }

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.landing',
      data: {
        before: card.landing ?? null,
        after,
      },
    },
  })
}

// task landing <task> [--landing pr|branch] [--merge owner|hydra] [--clear] sets this task's rule, or prints the one it follows.
export function taskLandingCommand({
  hydraId,
  ref,
  landing,
  merge,
  clear,
  meta,
}: {
  hydraId: string
  ref?: string
  landing?: string
  merge?: string
  clear: boolean
  meta: Meta
}): Output {
  const task = required({
    value: ref,
    what: 'task id',
  })

  if (landing === undefined && merge === undefined && !clear) {
    const state = loadHydra({ hydraId }).state
    const card = findCard({
      state,
      ref: task,
    })
    const rule = taskLanding({
      state,
      card,
    })

    if (!rule) {
      return {
        task: card.id,
        landing: 'none: the task has no project',
      }
    }

    return {
      task: card.id,
      ...rule,
      from: card.landing ? 'task' : 'project',
    }
  }

  return commit({
    hydraId,
    meta,
    intent: {
      type: 'task.landing',
      card: task,
    },
    decide: ({ state }) => decideTaskLanding({
      state,
      ref: task,
      landing,
      merge,
      clear,
      meta,
    }),
  })
}
