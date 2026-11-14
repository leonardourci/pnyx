import { AxiError } from 'axi-sdk-js'
import { WORKER_OWN_COMMANDS } from '#app/command-registry.ts'
import { requestEnv } from '#app/request-context.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'

const WORKER_PREFIX = 'worker:'

export type WorkerIdentity = {
  // Missing when the environment names a worker but not its task.
  task?: string
}

const taskOf = ({ actor }: { actor?: string }) =>
  actor?.startsWith(WORKER_PREFIX) ? actor.slice(WORKER_PREFIX.length) || undefined : undefined

// Whether a command line comes from a worker, and from which task. It reads every variable Pnyx sets for a worker
// and the --actor of one Pnyx does not run. It guards against a worker's mistakes; one that rewrites its own
// environment is not stopped.
export function workerIdentity({ actor }: { actor?: string } = {}): WorkerIdentity | undefined {
  const env = requestEnv()
  const started = env.PNYX_TASK && env.PNYX_TASK !== HYDRA_CARD ? env.PNYX_TASK : undefined
  const task = taskOf({ actor: env.PNYX_ACTOR }) ?? started ?? taskOf({ actor })
  const claimed = [
    env.PNYX_ACTOR,
    actor,
  ].some(name => name?.startsWith(WORKER_PREFIX))

  if (claimed || task !== undefined || env.PNYX_STEERING_WORKER) {
    return { task }
  }

  return undefined
}

// The actor a command records when none is declared: the worker's own, or the owner's terminal.
export function defaultActor(): string {
  const env = requestEnv()

  if (env.PNYX_ACTOR) {
    return env.PNYX_ACTOR
  }

  const identity = workerIdentity()

  return identity?.task ? `${WORKER_PREFIX}${identity.task}` : 'cli'
}

// The refusal of a command a worker may not run, listing what it may.
export function workerRefusal({ message }: { message: string }): AxiError {
  return new AxiError(
    message,
    'WORKER_SCOPE',
    [
      `A worker may run on its own task: ${WORKER_OWN_COMMANDS.join(', ')}; it reads any task or Hydra`,
      'Ask Hydra with `pnyx-axi task ask <task> --question "<what you need>"` for anything else',
    ],
  )
}
