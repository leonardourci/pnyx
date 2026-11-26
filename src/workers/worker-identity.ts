import { requestEnv } from '#app/request-context.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { TitanError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'

const WORKER_PREFIX = 'worker:'

export type WorkerIdentity = {
  // Missing when the environment names a worker but not its task.
  task?: string
}

const taskOf = ({ actor }: { actor?: string }) =>
  actor?.startsWith(WORKER_PREFIX) ? actor.slice(WORKER_PREFIX.length) || undefined : undefined

// Whether a command line comes from a worker, and from which task. It reads every variable Othrys sets for a worker
// and the --actor of one Othrys does not run. It guards against a worker's mistakes; one that rewrites its own
// environment is not stopped.
export function workerIdentity({
  actor,
  env = requestEnv(),
}: {
  actor?: string
  env?: NodeJS.ProcessEnv
} = {}): WorkerIdentity | undefined {
  const started = env.OTHRYS_TASK && env.OTHRYS_TASK !== TITAN_CARD ? env.OTHRYS_TASK : undefined
  const task = taskOf({ actor: env.OTHRYS_ACTOR }) ?? started ?? taskOf({ actor })
  const claimed = [
    env.OTHRYS_ACTOR,
    actor,
  ].some(name => name?.startsWith(WORKER_PREFIX))

  if (claimed || task !== undefined || env.OTHRYS_STEERING_WORKER) {
    return { task }
  }

  return undefined
}

// The actor a command records when none is declared: the worker's own, or the owner's terminal.
export function defaultActor(): string {
  const env = requestEnv()

  if (env.OTHRYS_ACTOR) {
    return env.OTHRYS_ACTOR
  }

  const identity = workerIdentity()

  return identity?.task ? `${WORKER_PREFIX}${identity.task}` : 'cli'
}

export function requirePermissionApprover({
  actor,
  titanId,
  card,
  session,
}: {
  actor: string
  titanId: string
  card: Pick<Card, 'id' | 'key'>
  session?: string
}): void {
  const worker = workerIdentity({ actor })
  const ownWorker = worker?.task === card.id || worker?.task === card.key
  const env = requestEnv()
  const titanIdentity = actor === 'titan' || env.OTHRYS_ACTOR === 'titan' || env.OTHRYS_TASK === TITAN_CARD
  const ownTitan = card.id === TITAN_CARD && titanIdentity
    && (env.OTHRYS_TITAN === undefined || env.OTHRYS_TITAN === titanId)
  const ownSession = session !== undefined && [
    actor,
    env.OTHRYS_ACTOR,
  ].includes(`session:${session}`)

  if (ownTitan || ownWorker || ownSession) {
    throw new TitanError({
      message: 'An agent cannot approve its own permission request',
      code: 'NO_ROUTE',
      help: ['The owner or another agent answers the pending request'],
    })
  }
}
