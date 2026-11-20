import { inform } from '#app/command-notices.ts'
import { commit, required, type Output } from '#app/cli-support.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { hydraEvent, reportActor } from '#hydra/hydra.ts'
import type { HydraState } from '#app/model.ts'
import type { LandingRule } from './model.ts'
import { loadHydra } from '#app/store.ts'
import { parseLanding, parseMerger, taskLanding } from './rule.ts'

function decideTaskLanding({
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
    inform({
      reason: 'Landing rule changed by a worker',
      clear: 'pnyx-axi task landing <task> --clear',
      task: card.id,
    })
  }

  let after: LandingRule | null = null

  if (!clear) {
    const inherited = taskLanding({
      state,
      card,
    })

    if (!inherited) {
      inform({
        task: card.id,
        reason: 'Task has no project; using pr landing and owner merge defaults',
        clear: `Use pnyx-axi task rename ${card.id} --project <project> to attach it`,
      })
    }

    const current = inherited ?? {
      landing: 'pr' as const,
      merge: 'owner' as const,
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
