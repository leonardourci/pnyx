import { HydraError, type Card, type HydraState } from '../core/model.ts'
import { reportActor } from '../core/hydra.ts'
import { AxiError } from 'axi-sdk-js'
import { findCard } from '../core/decide.ts'
import { loadHydra } from '../store/hydra-store.ts'
import { helperTask } from './route.ts'
import { isHelper, taskLease } from './leases.ts'

const TASK_READS = [
  'list',
  'show',
  'history',
  'chat',
  'sessions',
]
const TASK_WRITES = [
  'continue',
  'answer',
]
const READS: Record<string, string[]> = {
  hydra: [
    'check',
    'messages',
    'show',
  ],
  project: [
    'list',
    'show',
  ],
  owner: ['memory'],
}

function flagValue({
  args,
  name,
}: {
  args: string[]
  name: string
}): string | undefined {
  const index = args.indexOf(name)

  if (index >= 0) {
    return args[index + 1]
  }

  return args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1)
}

function denied(): never {
  throw new AxiError(
    'This action belongs to the main Hydra; record an owner outcome for it',
    'MAIN_ONLY',
  )
}

export function commandLease({
  name,
  args,
  env = process.env,
}: {
  name: string
  args: string[]
  env?: NodeJS.ProcessEnv
}): () => void {
  const actor = env.PNYX_ACTOR ?? flagValue({
    args,
    name: '--actor',
  }) ?? 'cli'
  const helper = isHelper({ actor })

  if (reportActor({ actor })) {
    return () => {}
  }

  const hydraId = flagValue({
    args,
    name: '--hydra',
  }) ?? env.PNYX_HYDRA ?? 'default'
  const action = args[0] ?? ''
  let task: string | undefined

  if (helper) {
    const requestedActor = flagValue({
      args,
      name: '--actor',
    })
    const sameActor = requestedActor === undefined || requestedActor === actor

    if (hydraId !== env.PNYX_HYDRA || !sameActor || args.some(arg => /^--wait(?:=|$)/.test(arg))) {
      denied()
    }

    if (name === 'task') {
      if (!TASK_READS.includes(action) && !TASK_WRITES.includes(action)) {
        denied()
      }
    } else if (name === 'reply') {
      if (args.some(arg => /^--(?:key|answer|json|model|effort|mode)(?:=|$)/.test(arg))) {
        denied()
      }
    } else if (!READS[name]?.includes(action)
      || (name === 'owner' && args[1] !== 'list')) {
      denied()
    }
  }

  if (name === 'task' && !TASK_READS.includes(action) && action !== 'create') {
    task = args[1]
  } else if ([
    'reply',
    'move',
    'link',
    'outcome',
  ].includes(name)) {
    task = args[0]
  }

  if (!task || task.startsWith('--')) {
    if (helper && (name === 'reply' || TASK_WRITES.includes(action))) {
      denied()
    }

    return () => {}
  }

  let state: HydraState
  let card: Card

  try {
    state = loadHydra({ hydraId }).state
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
    const batch = state.helper?.runs[actor.slice('helper:'.length)]

    if (!batch || batch.error || !batch.tasks.includes(card.id) || !helperTask({
      state,
      task: card.id,
    })) {
      denied()
    }

    if (action === 'answer') {
      const ask = card.asks?.find(ask => ask.id === args[2])

      if (!ask || ask.audience !== 'hydra' || ask.escalated) {
        denied()
      }
    }
  }

  return taskLease({
    hydraId,
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

// eslint-disable-next-line pnyx/object-params -- The AXI SDK owns the command signature.
type Command = (args: string[]) => unknown

export function supervisedCommands<T extends Record<string, Command>>({ commands }: {
  commands: T
}): T {
  return Object.fromEntries(Object.entries(commands).map(([
    name,
    run,
  ]) => [
    name,
    // eslint-disable-next-line pnyx/object-params -- The AXI SDK owns the command signature.
    (args: string[]) => {
      let release = () => {}

      try {
        release = commandLease({
          name,
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

        if (error instanceof HydraError) {
          throw new AxiError(
            error.message,
            error.code,
            error.help,
          )
        }

        throw error
      }
    },
  ])) as T
}
