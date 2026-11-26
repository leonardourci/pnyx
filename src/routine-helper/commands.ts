import { inform } from '#app/command-notices.ts'
import { requireCopyAvailable } from '#projects/copy-lease.ts'
import { parseArgs } from 'node:util'
import { TASK_OPTIONS } from '#app/task-cli.ts'
import type { TitanState } from '#app/model.ts'
import { TitanError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import { reportActor } from '#titan/titan.ts'
import { findCard } from '#tasks/push-rules.ts'
import { loadTitan } from '#app/store.ts'
import { helperGrant } from './route.ts'
import { HELPER_TASK_WRITES, helperReads } from '#app/command-registry.ts'
import { isHelper, taskLease } from './leases.ts'
import { requestEnv } from '#app/request-context.ts'

const TASK_READS = helperReads({ name: 'task' })
const TASK_WRITES = HELPER_TASK_WRITES

function denied(): void {
  inform({
    reason: 'Helper acted outside its default task scope',
    clear: 'Read the task’s task.log to inspect the change',
  })
}

function commandLease({
  name,
  args,
  env = requestEnv(),
}: {
  name: string
  args: string[]
  env?: NodeJS.ProcessEnv
}): () => void {
  const options = name === 'task' ? TASK_OPTIONS : {
    ...TASK_OPTIONS,
    json: { type: 'string' as const },
    home: {
      type: 'string' as const,
      multiple: true,
    },
    wait: { type: 'string' as const },
    after: { type: 'string' as const },
    confirm: { type: 'boolean' as const },
  }
  const {
    values,
    positionals,
  } = parseArgs({
    args,
    options,
    allowPositionals: true,
    strict: false,
  })
  const actor = env.OTHRYS_ACTOR ?? String(values.actor ?? 'cli')
  const helper = isHelper({ actor })

  if (reportActor({ actor })) {
    return () => {}
  }

  const titanId = String(values.titan ?? env.OTHRYS_TITAN ?? 'default')
  const action = positionals[0] ?? ''
  let task: string | undefined

  if (helper) {
    const requestedActor = values.actor
    const sameActor = requestedActor === undefined || requestedActor === actor

    if (titanId !== env.OTHRYS_TITAN || !sameActor || args.some(arg => /^--wait(?:=|$)/.test(arg))) {
      denied()
    }

    if (name === 'task') {
      if (!TASK_READS.includes(action) && !TASK_WRITES.some(write => write === action)) {
        denied()
      }
    } else if (name === 'reply') {
      if (args.some(arg => /^--(?:key|answer|json|model|effort|mode)(?:=|$)/.test(arg))) {
        denied()
      }
    } else if (!helperReads({ name }).includes(action)
      || (name === 'owner' && positionals[1] !== 'list')) {
      denied()
    }
  }

  if (name === 'task' && !TASK_READS.includes(action) && action !== 'create') {
    task = positionals[1]
  } else if ([
    'reply',
    'agent',
    'move',
    'link',
    'outcome',
  ].includes(name)) {
    task = positionals[0]
  }

  if (!task || task.startsWith('--')) {
    if (helper && (name === 'reply' || TASK_WRITES.some(write => write === action))) {
      denied()
    }

    return () => {}
  }

  let state: TitanState
  let card: Card

  try {
    state = loadTitan({ titanId }).state
    card = findCard({
      state,
      ref: task,
    })
  } catch (error) {
    if (helper) {
      throw error
    }

    return () => {}
  }

  if (helper) {
    if (!helperGrant({
      state,
      task: card.id,
      actor,
      action: name === 'reply' ? 'reply' : TASK_WRITES.find(write => write === action),
    })) {
      denied()
    }

    if (action === 'answer') {
      const ask = card.asks?.find(ask => ask.id === positionals[2])

      if (!ask || ask.audience !== 'titan' || ask.escalated) {
        denied()
      }
    }
  }

  // A message from main or the owner queues for the agent; it never waits on or takes the helper's lease.
  if (!helper && name === 'reply') {
    return () => {}
  }

  if (name === 'task' && action === 'copy' && positionals[2] === 'remove') {
    return () => {}
  }

  requireCopyAvailable({
    titanId,
    task: card.id,
  })

  return taskLease({
    titanId,
    task: card.id,
    actor: helper ? actor : 'main',
  })
}

async function releaseAfter({
  result,
  release,
}: {
  result: Promise<unknown>
  release(): void
}) {
  try {
    return await result
  } finally {
    release()
  }
}

type Command = (args: string[]) => unknown

export function supervisedCommands<T extends Record<string, Command>>({ commands }: {
  commands: T
}): T {
  return Object.fromEntries(Object.entries(commands).map(([
    name,
    run,
  ]) => [
    name,
    (args: string[]) => {
      let release = () => {}

      try {
        release = commandLease({
          name: name,
          args,
        })
        const result = run(args)

        if (result instanceof Promise) {
          return releaseAfter({
            result,
            release,
          })
        }

        release()

        return result
      } catch (error) {
        release()

        if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
          throw new TitanError({
            message: error.message,
            code: 'VALIDATION_ERROR',
            help: ['Run the command with --help'],
          })
        }

        throw error
      }
    },
  ])) as T
}
