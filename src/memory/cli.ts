import { findProject } from '#projects/read.ts'
import { readOwnerLogs } from './owner-memory-log.ts'
import { memorySize, OWNER_MEMORY_BUDGET, TITAN_MEMORY_BUDGET, OWNER_DOCUMENTS, checkBudget, type Memory } from './budgets.ts'
import { required, guard, parse, integer, COMMON, WRITE, meta, commit, explained, type Output } from '#app/cli-support.ts'
import { staleLearnings, learningChange } from './learnings.ts'
import { memoryConditions } from './conditions.ts'
import { TitanError } from '#store/errors.ts'
import { migrateOwnerMemory, ownerMemory, writableOwnerMemory, ownerArchive, saveOwnerMemory, moveOwnerLearning, moveOwnerPolis, type OwnerMeta } from './owner-memory.ts'
import { withRegistryLock } from '#store/storage.ts'
import { loadTitan } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { scanEvents } from '#app/event-log.ts'
import { hydraEvent } from '#titan/titan.ts'
import { checkWorkerNotes, workerNotesNotice } from './workers.ts'
import { POLIS_NAME } from './owner-polis.ts'

function memoryList({
  memory,
  budgetMemory = memory,
  budget,
  empty,
}: {
  memory: Memory
  budgetMemory?: Memory
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
    used: `${memorySize({ memory: budgetMemory })} of ${budget} characters`,
  }
}

function memoryChange({
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
    throw new TitanError({
      message: `${usage}; keys use lowercase letters, digits and dashes`,
      code: 'VALIDATION_ERROR',
    })
  }

  const after = action === 'forget' ? null : required({
    value: values.text as string | undefined,
    what: '--text',
  }).trim()

  if (after !== null && !after) {
    throw new TitanError({
      message: 'memory text must not be empty',
      code: 'VALIDATION_ERROR',
    })
  }

  return {
    key,
    after,
  }
}

function ownerMeta({ values }: {
  values: Record<string, string | boolean | undefined>
}): OwnerMeta {
  const revision = values['if-revision']

  if (revision === undefined) {
    return meta({ values })
  }

  const parts = String(revision).split(':')
  const [
    first,
    second,
  ] = parts
  const polis = second === undefined ? 'shared' : first

  if (polis === undefined || !POLIS_NAME.test(polis) || parts.length > 2) {
    throw new TitanError({
      message: 'Use the revision from owner memory list',
      code: 'VALIDATION_ERROR',
    })
  }

  return {
    ...meta({
      values: {
        ...values,
        'if-revision': parts.at(-1),
      },
    }),
    ifPolis: polis,
  }
}

export const owner = guard({
  handler: async ({ args }) => {
    const usage = 'use owner memory list|set|forget|confirm|move|save|archive or owner worker-notes set|forget'
    const workerNotes = args[0] === 'worker-notes'

    if (workerNotes && ![
      'set',
      'forget',
    ].includes(args[1] ?? '')) {
      throw new TitanError({
        message: usage,
        code: 'VALIDATION_ERROR',
      })
    }

    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args: workerNotes ? [
        'memory',
        ...args.slice(1),
        '--key',
        'workers',
      ] : args,
      // Owner memory has no events or cards, so it takes only the write flags it honours.
      options: {
        ...COMMON,
        actor: WRITE.actor!,
        reason: WRITE.reason!,
        'if-revision': WRITE['if-revision']!,
        key: { type: 'string' },
        text: { type: 'string' },
        project: { type: 'string' },
        to: { type: 'string' },
        'if-destination-revision': { type: 'string' },
        kind: { type: 'string' },
        until: { type: 'string' },
        used: { type: 'string' },
      },
      positionals: 2,
    })

    if (positionals[0] !== 'memory') {
      throw new TitanError({
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
      await migrateOwnerMemory()

      return withRegistryLock({
        fn: () => {
          const logs = readOwnerLogs()
          const memory = ownerMemory({
            migrate: false,
            logs,
          })
          const writable = writableOwnerMemory({
            hydraId,
            logs,
          })

          return {
            ...memoryList({
              memory,
              budgetMemory: writable.memory,
              budget: OWNER_MEMORY_BUDGET,
              empty: 'none: no owner memory yet',
            }),
            revision: writable.revision,
            writable: writable.memory,
            archived: ownerArchive({logs}),
          }
        },
      })
    }

    if (action === 'save' || action === 'archive') {
      const entry = await saveOwnerMemory({
        hydraId,
        key: 'learnings',
        after: null,
        learning,
        meta: ownerMeta({ values }),
      })

      return {
        memory: 'learnings',
        state: action === 'save' ? 'saved' : 'archived',
        revision: entry?.revision,
      }
    }

    const documentMove = values.to !== undefined
    const hasLearningSelector = values.project !== undefined || values.text !== undefined
    const mixedMoveSelectors = documentMove ? hasLearningSelector : values.key !== undefined

    if (action === 'move' && mixedMoveSelectors) {
      throw new TitanError({
        message: 'Use --key and --to for a document move, or --project and --text for a learning move',
        code: 'VALIDATION_ERROR',
      })
    }

    if (action === 'move' && documentMove) {
      return await moveOwnerPolis({
        hydraId,
        ifDestinationRevision: integer({
          value: values['if-destination-revision'],
          flag: '--if-destination-revision',
        }),
        destination: String(values.to),
        key: required({
          value: values.key as string | undefined,
          what: '--key',
        }),
        meta: ownerMeta({ values }),
      })
    }

    if (action === 'move') {
      const project = findProject({
        state: loadTitan({ hydraId }).state,
        ref: required({
          value: values.project as string | undefined,
          what: '--project <name|path>',
        }),
        attached: true,
      })

      return moveOwnerLearning({
        ifDestinationRevision: integer({
          value: values['if-destination-revision'],
          flag: '--if-destination-revision',
        }),
        path: project.path,
        hydraId,
        text: required({
          value: values.text as string | undefined,
          what: '--text <existing learning line>',
        }),
        meta: ownerMeta({ values }),
      })
    }

    if (action === 'confirm') {
      const line = required({
        value: values.text as string | undefined,
        what: '--text <existing learning line>',
      })
      const entry = await saveOwnerMemory({
        hydraId,
        key: 'learnings',
        after: null,
        confirmed: line,
        meta: ownerMeta({ values }),
      })

      return {
        memory: 'learnings',
        state: 'confirmed',
        revision: entry?.revision,
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
    const m = ownerMeta({ values })

    if (key === 'workers') {
      checkWorkerNotes({
        text: after,
        reason: m.reason,
      })
    }

    const entry = await saveOwnerMemory({
      hydraId,
      key,
      after,
      learning,
      meta: m,
    })

    return entry ? {
      memory: key,
      state: after === null ? 'forgotten' : 'saved',
      revision: entry.revision,
      used: `${memorySize({ memory: writableOwnerMemory({ hydraId }).memory })} of ${OWNER_MEMORY_BUDGET} characters`,
    } : {
      memory: key,
      skipped: 'unchanged',
    }
  },
})

export async function hydraMemory({
  values,
  positionals,
  hydraId,
}: {
  values: Record<string, string | boolean | undefined>
  positionals: string[]
  hydraId: string
}): Promise<Output> {
  const action = positionals[1] ?? 'list'

  if (action === 'list') {
    const state = loadTitan({ hydraId }).state

    return memoryList({
      memory: state.hydraMemory ?? {},
      budget: TITAN_MEMORY_BUDGET,
      empty: 'none: no Titan memory yet',
    })
  }

  const {
    key,
    after,
  } = memoryChange({
    action,
    values,
    usage: 'use hydra memory list|set|forget',
  })

  if (key === 'inscribe-cursor' && after !== null) {
    throw new TitanError({
      message: 'Finish the inscribe milestone with hydra inscribe finish --through <snapshot>',
      code: 'VALIDATION_ERROR',
    })
  }

  if (after !== null && Object.hasOwn(
    OWNER_DOCUMENTS,
    key,
  )) {
    throw new TitanError({
      message: `${OWNER_DOCUMENTS[key as keyof typeof OWNER_DOCUMENTS]} belong in owner memory`,
      code: 'VALIDATION_ERROR',
      help: ['Keep owner documents in owner memory; use another key for notes specific to this Titan'],
    })
  }

  const m = meta({ values })

  if (key === 'workers') {
    explained({ meta: m })
    checkWorkerNotes({
      text: after,
      reason: m.reason,
    })
  }

  const result = await commit({
    hydraId,
    meta: m,
    intent: {
      type: 'hydra.memory',
      card: '$board',
    },
    decide: ({ state }) => {
      const before = state.hydraMemory?.[key]?.text ?? null
      checkBudget({
        memory: state.hydraMemory ?? {},
        key,
        after,
        budget: TITAN_MEMORY_BUDGET,
        layer: 'Titan',
      })

      return before === after ? { skipped: 'unchanged' } : hydraEvent({
        state,
        meta: m,
        cardId: '$board',
        change: {
          type: 'hydra.memory',
          data: {
            key,
            before,
            after,
          },
        },
      })
    },
  })

  if (key === 'workers' && result.event === 'none: unchanged') {
    await withWriter({
      hydraId,
      fn: ({ writer }) => {
        const saved = scanEvents({
          hydraId,
          types: ['hydra.memory'],
          descending: true,
        }).find(event => event.type === 'hydra.memory' && event.data.key === 'workers')

        if (saved) {
          workerNotesNotice({
            writer,
            target: `Titan ${hydraId}`,
            meta: saved,
          })
        }
      },
    })
  }

  return result
}
