import { memorySize, OWNER_MEMORY_BUDGET, HYDRA_MEMORY_BUDGET, OWNER_DOCUMENTS, checkBudget, type Memory } from './budgets.ts'
import { required, guard, parse, integer, COMMON, WRITE, meta, commit, explained, type Output } from '#app/cli-support.ts'
import { staleLearnings, learningChange } from './learnings.ts'
import { memoryConditions } from './conditions.ts'
import { HydraError } from '#store/errors.ts'
import { migrateOwnerMemory, ownerMemory, writableOwnerMemory, ownerArchive, saveOwnerMemory, moveOwnerLearning, moveOwnerPolis, type OwnerMeta } from './owner-memory.ts'
import { withRegistryLock } from '#store/storage.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { scanEvents } from '#app/event-log.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { checkWorkerNotes, workerNotesNotice } from './workers.ts'
import { findReadableProject, memoryCaller } from './poleis.ts'
import { POLIS_NAME } from './polis-policy.ts'

function memoryList({
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
    throw new HydraError({
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
      throw new HydraError({
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
        propose: { type: 'boolean' },
        'if-destination-revision': { type: 'string' },
        kind: { type: 'string' },
        until: { type: 'string' },
        used: { type: 'string' },
      },
      positionals: 2,
    })

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
      if (memoryCaller({ hydraId })) {
        migrateOwnerMemory()
      }

      return withRegistryLock({
        fn: () => {
          const memory = ownerMemory({
            hydraId,
            migrate: false,
          })
          const writable = writableOwnerMemory({ hydraId })

          return {
            ...memoryList({
              memory,
              budget: OWNER_MEMORY_BUDGET,
              empty: 'none: no owner memory yet',
            }),
            used: `${memorySize({ memory: writable?.memory ?? {} })} of ${OWNER_MEMORY_BUDGET} characters`,
            revision: writable?.revision,
            writable: writable?.memory,
            archived: ownerArchive({ hydraId }),
          }
        },
      })
    }

    if (action === 'save' || action === 'archive') {
      const entry = saveOwnerMemory({
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

    if (action === 'move' && values.to !== undefined) {
      return moveOwnerPolis({
        hydraId,
        args,
        propose: Boolean(values.propose),
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
      const project = await findReadableProject({
        hydraId,
        state: loadHydra({ hydraId }).state,
        attached: true,
        ref: required({
          value: values.project as string | undefined,
          what: '--project <name|path>',
        }),
        attached: true,
      })

      return moveOwnerLearning({
        args,
        propose: Boolean(values.propose),
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
      const entry = saveOwnerMemory({
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

    const entry = saveOwnerMemory({
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
      used: `${memorySize({ memory: writableOwnerMemory({ hydraId })?.memory ?? {} })} of ${OWNER_MEMORY_BUDGET} characters`,
    } : {
      memory: key,
      skipped: 'unchanged',
    }
  },
})

export function hydraMemory({
  values,
  positionals,
  hydraId,
}: {
  values: Record<string, string | boolean | undefined>
  positionals: string[]
  hydraId: string
}): Output {
  const action = positionals[1] ?? 'list'

  if (!memoryCaller({ hydraId })) {
    if (action === 'list') {
      return memoryList({
        memory: {},
        budget: HYDRA_MEMORY_BUDGET,
        empty: 'none: no Hydra memory yet',
      })
    }

    throw new HydraError({
      message: 'Memory is unavailable',
      code: 'NOT_FOUND',
    })
  }

  if (action === 'list') {
    const state = loadHydra({ hydraId }).state

    return memoryList({
      memory: state.hydraMemory ?? {},
      budget: HYDRA_MEMORY_BUDGET,
      empty: 'none: no Hydra memory yet',
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
    throw new HydraError({
      message: 'Finish the inscribe milestone with hydra inscribe finish --through <snapshot>',
      code: 'VALIDATION_ERROR',
    })
  }

  if (after !== null && Object.hasOwn(
    OWNER_DOCUMENTS,
    key,
  )) {
    throw new HydraError({
      message: `${OWNER_DOCUMENTS[key as keyof typeof OWNER_DOCUMENTS]} belong in owner memory`,
      code: 'VALIDATION_ERROR',
      help: [`Run \`pnyx-axi owner memory set --key ${key} --text "<document>"\`, or save a note only this Hydra needs under another key`],
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

  const result = commit({
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
        budget: HYDRA_MEMORY_BUDGET,
        layer: 'Hydra',
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
    withWriter({
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
            target: `Hydra ${hydraId}`,
            meta: saved,
          })
        }
      },
    })
  }

  return result
}
