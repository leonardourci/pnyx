import { requestEnv } from '#app/request-context.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'

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
export function workerIdentity({
  actor,
  env = requestEnv(),
}: {
  actor?: string
  env?: NodeJS.ProcessEnv
} = {}): WorkerIdentity | undefined {
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

export function requirePermissionApprover({
  actor,
  hydraId,
  card,
  session,
}: {
  actor: string
  hydraId: string
  card: Pick<Card, 'id' | 'key'>
  session?: string
}): void {
  const worker = workerIdentity({ actor })
  const ownWorker = worker?.task === card.id || worker?.task === card.key
  const env = requestEnv()
  const hydraIdentity = actor === 'hydra' || env.PNYX_ACTOR === 'hydra' || env.PNYX_TASK === HYDRA_CARD
  const ownHydra = card.id === HYDRA_CARD && hydraIdentity
    && (env.PNYX_HYDRA === undefined || env.PNYX_HYDRA === hydraId)
  const ownSession = session !== undefined && [
    actor,
    env.PNYX_ACTOR,
  ].includes(`session:${session}`)

  if (ownHydra || ownWorker || ownSession) {
    throw new HydraError({
      message: 'An agent cannot approve its own permission request',
      code: 'NO_ROUTE',
      help: ['The owner or another agent answers the pending request'],
    })
  }
}
