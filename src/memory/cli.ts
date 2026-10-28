import { memorySize, OWNER_MEMORY_BUDGET, type Memory } from './budgets.ts'
import { required, guard, parse, COMMON, WRITE, meta, type Output } from '../app/cli-support.ts'
import { staleLearnings, learningChange } from './learnings.ts'
import { memoryConditions } from './conditions.ts'
import { HydraError } from '../store/errors.ts'
import { ownerMemory, ownerRevision, ownerArchive, saveOwnerMemory, moveOwnerLearning } from './owner-memory.ts'
import { findProject } from '../projects/read.ts'
import { loadHydra } from '../app/store.ts'

export function memoryList({
  memory,
  budget,
  empty,
}: {
  memory: Memory
  budget: number
  empty: string
}): Output {
  const entries = Object.entries(memory).map(([
    key,
    entry,
  ]) => {
    const row: Output = {
      key,
      ...entry,
    }

    if (entry.lines) {
      row.stale = staleLearnings({
        lines: entry.lines,
        conditions: memoryConditions(),
        now: new Date().toISOString(),
      })
    }

    return row
  })

  return {
    memory: entries.length ? entries : empty,
    used: `${memorySize({ memory })} of ${budget} characters`,
  }
}

export function memoryChange({
  action,
  values,
  usage,
}: {
  action: string
  values: Record<string, string | boolean | undefined>
  usage: string
}): {
  key: string
  after: string | null
} {
  const key = required({
    value: values.key as string | undefined,
    what: '--key',
  })

  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(key) || ![
    'set',
    'forget',
  ].includes(action)) {
    throw new HydraError({
      message: `${usage}; keys use lowercase letters, digits and dashes`,
      code: 'VALIDATION_ERROR',
    })
  }

  const after = action === 'forget' ? null : required({
    value: values.text as string | undefined,
    what: '--text',
  }).trim()

  if (after !== null && !after) {
    throw new HydraError({
      message: 'memory text must not be empty',
      code: 'VALIDATION_ERROR',
    })
  }

  return {
    key,
    after,
  }
}

export const owner = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      // Owner memory has no events or cards, so it takes only the write flags it honours.
      options: {
        ...COMMON,
        actor: WRITE.actor!,
        reason: WRITE.reason!,
        'if-revision': WRITE['if-revision']!,
        key: { type: 'string' },
        text: { type: 'string' },
        project: { type: 'string' },
        kind: { type: 'string' },
        until: { type: 'string' },
        used: { type: 'string' },
      },
      positionals: 2,
    })
    const usage = 'use owner memory list|set|forget|confirm|move|save|archive'

    if (positionals[0] !== 'memory') {
      throw new HydraError({
        message: usage,
        code: 'VALIDATION_ERROR',
      })
    }

    const action = positionals[1] ?? 'list'
    const learning = learningChange({
      action,
      kind: values.kind as string | undefined,
      until: values.until as string | undefined,
      used: values.used as string | undefined,
      text: values.text as string | undefined,
    })

    if (action === 'list') {
      return {
        ...memoryList({
          memory: ownerMemory(),
          budget: OWNER_MEMORY_BUDGET,
          empty: 'none: no owner memory yet',
        }),
        revision: ownerRevision(),
        archived: ownerArchive(),
      }
    }

    if (action === 'save' || action === 'archive') {
      const entry = saveOwnerMemory({
        key: 'learnings',
        after: null,
        learning,
        meta: meta({ values }),
      })

      return {
        memory: 'learnings',
        state: action === 'save' ? 'saved' : 'archived',
        revision: entry?.seq,
      }
    }

    if (action === 'move') {
      const project = findProject({
        state: loadHydra({ hydraId }).state,
        ref: required({
          value: values.project as string | undefined,
          what: '--project <name|path>',
        }),
        attached: true,
      })

      return moveOwnerLearning({
        path: project.path,
        hydraId,
        text: required({
          value: values.text as string | undefined,
          what: '--text <existing learning line>',
        }),
        meta: meta({ values }),
      })
    }

    if (action === 'confirm') {
      const memory = ownerMemory()
      const line = required({
        value: values.text as string | undefined,
        what: '--text <existing learning line>',
      })
      const entry = saveOwnerMemory({
        key: 'learnings',
        after: memory.learnings?.text ?? null,
        confirmed: line,
        meta: meta({ values }),
      })

      return {
        memory: 'learnings',
        state: 'confirmed',
        revision: entry?.seq,
      }
    }

    const {
      key,
      after,
    } = memoryChange({
      action,
      values,
      usage,
    })
    const entry = saveOwnerMemory({
      key,
      after,
      learning,
      meta: meta({ values }),
    })

    return entry ? {
      memory: key,
      state: after === null ? 'forgotten' : 'saved',
      revision: entry.seq,
      used: `${memorySize({ memory: ownerMemory() })} of ${OWNER_MEMORY_BUDGET} characters`,
    } : {
      memory: key,
      skipped: 'unchanged',
    }
  },
})
