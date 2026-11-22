import { inform } from '#app/command-notices.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { helperGrant } from './route.ts'
import { join } from 'node:path'
import { HydraError } from '#store/errors.ts'
import { hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'

export const COPY_LEASE_PREFIX = 'copy-settlement:'

interface Lease {
  actor: string
  holders: {
    id: string
    pid: number
    actor?: string
  }[]
}

export const isHelper = ({ actor }: { actor: string }) => actor.startsWith('helper:')

export function copySettlingRefusal({
  task,
  code,
}: {
  task: string
  code: string
}): HydraError {
  return new HydraError({
    message: `Task ${task} is settling its copy; try again when cleanup finishes`,
    code,
    help: [`Read tasks/${task}/task.log for the copy's state`],
  })
}

const leasePath = ({
  dir,
  task,
}: {
  dir: string
  task: string
}) => join(
  dir,
  `helper-lease-${encodeURIComponent(task)}.json`,
)

const leases = new Map<string, Lease>()

export function dropCopyLeases({ hydraId }: { hydraId: string }): void {
  const dir = hydraDir({ hydraId })

  for (const [
    path,
    lease,
  ] of leases) {
    if (path.startsWith(`${dir}/`) && lease.actor.startsWith(COPY_LEASE_PREFIX)) {
      leases.delete(path)
    }
  }
}

export function taskLeasePresent({
  hydraId,
  task,
  actorPrefix,
}: {
  hydraId: string
  task: string
  actorPrefix?: string
}): boolean {
  const lease = leases.get(leasePath({
    dir: hydraDir({ hydraId }),
    task,
  }))

  return lease !== undefined && (actorPrefix === undefined || lease.actor.startsWith(actorPrefix))
}

const readLease = ({ path }: {
  path: string
  cleanup?: boolean
}): Lease | undefined => leases.get(path)

const writeLease = ({
  path,
  lease,
}: {
  path: string
  lease: Lease
}): void => {
  leases.set(
    path,
    lease,
  )
}

// Set while Pnyx delivers a message to a task's agent; the delivery's own writes pass a helper's lease.
export const deliveringMessage = new AsyncLocalStorage<true>()

export function guardTaskLease({
  dir,
  task,
  actor,
}: {
  dir: string
  task: string
  actor: string
}): void {
  const lease = readLease({
    cleanup: false,
    path: leasePath({
      dir,
      task,
    }),
  })
  const helper = isHelper({ actor })

  const otherHelper = !helper && lease && isHelper({ actor: lease.actor })

  if ((helper && lease?.actor !== actor) || otherHelper) {
    inform({
      task,
      reason: `Task is leased to ${lease?.actor ?? 'another Hydra session'}`,
      clear: `Read tasks/${task}/task.log to inspect overlapping work`,
    })
  }
}

export function taskLease({
  hydraId,
  task,
  actor,
  message = false,
  pid = process.pid,
}: {
  hydraId: string
  task: string
  actor: string
  message?: boolean
  pid?: number
  lockTimeout?: number
}): () => void {
  const holder = randomUUID()
  let owner = actor
  const dir = hydraDir({ hydraId })
  const path = leasePath({
    dir,
    task,
  })
  const lease = readLease({ path })

  const copyHeld = message && lease?.actor.startsWith(COPY_LEASE_PREFIX)

  if (message && lease && !copyHeld) {
    owner = lease.actor
  }

  if (lease && (lease.actor !== owner || copyHeld)) {
    if (actor.startsWith(COPY_LEASE_PREFIX) || lease.actor.startsWith(COPY_LEASE_PREFIX)) {
      throw copySettlingRefusal({
        task,
        code: 'TASK_LEASED',
      })
    }

    inform({
      task,
      reason: `Task is also being handled by ${lease.actor}`,
      clear: `Read tasks/${task}/task.log to inspect overlapping work`,
    })

    owner = lease.actor
  }

  if (isHelper({ actor }) && !helperGrant({
    state: loadHydra({ hydraId }).state,
    actor,
    task,
  })) {
    inform({
      task,
      reason: 'Helper has no current task grant',
      clear: `Read tasks/${task}/task.log to inspect the change`,
    })
  }

  const holders = [
    ...lease?.holders ?? [],
    {
      id: holder,
      pid,
      actor,
    },
  ]
  writeLease({
    path,
    lease: {
      actor: owner,
      holders,
    },
  })

  return () => {
    releaseTask({
      hydraId,
      task,
      actor: owner,
      holder,
    })
  }
}

export function releaseTask({
  hydraId,
  task,
  actor,
  holder,
}: {
  hydraId: string
  task: string
  actor: string
  holder?: string
  lockTimeout?: number
}): void {
  const dir = hydraDir({ hydraId })
  const path = leasePath({
    dir,
    task,
  })
  const lease = readLease({ path })

  if (lease?.actor === actor) {
    lease.holders = lease.holders.filter(entry => {
      if (holder) {
        return entry.id !== holder
      }

      return entry.pid !== process.pid || (entry.actor ?? lease.actor) !== actor
    })

    if (lease.holders.length) {
      writeLease({
        path,
        lease,
      })
    } else {
      leases.delete(path)
    }
  }
}
