import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { helperGrant } from './route.ts'
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HydraError } from '#store/errors.ts'
import { hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { acquireLock } from '#store/storage.ts'

export const COPY_LEASE_PREFIX = 'copy-settlement:'

interface Lease {
  actor: string
  holders: {
    id: string
    pid: number
  }[]
}

export const isHelper = ({ actor }: { actor: string }) => actor.startsWith('helper:')

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

// Only the server settles copies, so a settlement lease it finds when it mounts a Hydra was left by a server that stopped mid-settlement.
export function dropCopyLeases({ hydraId }: { hydraId: string }): void {
  const dir = hydraDir({ hydraId })
  const unlock = acquireLock({ dir })

  try {
    for (const name of readdirSync(dir).filter(name => name.startsWith('helper-lease-') && name.endsWith('.json'))) {
      const path = join(
        dir,
        name,
      )
      let actor: unknown

      try {
        actor = JSON.parse(readFileSync(
          path,
          'utf8',
        )).actor
      } catch {
        // An unreadable lease is not provably a settlement's, so it stays.
        continue
      }

      // Its holder's pid may belong to any process by now, so liveness is not checked.
      if (typeof actor === 'string' && actor.startsWith(COPY_LEASE_PREFIX)) {
        rmSync(path)
      }
    }
  } finally {
    unlock()
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
  const path = leasePath({
    dir: hydraDir({ hydraId }),
    task,
  })

  try {
    const entry = lstatSync(
      path,
      { throwIfNoEntry: false },
    )

    if (!entry) {
      return false
    }

    if (!entry.isFile()) {
      return true
    }

    const lease = readLease({
      path,
      cleanup: false,
    })

    return lease !== undefined && (actorPrefix === undefined || lease.actor.startsWith(actorPrefix))
  } catch {
    // Unknown ownership must never authorize an automatic resend.
    return true
  }
}

function readLease({
  path,
  cleanup = true,
}: {
  path: string
  cleanup?: boolean
}): Lease | undefined {
  if (!existsSync(path)) {
    return undefined
  }

  const lease: Lease = JSON.parse(readFileSync(
    path,
    'utf8',
  ))

  if (typeof lease.actor !== 'string' || !Array.isArray(lease.holders)
    || lease.holders.some(holder => typeof holder.id !== 'string' || !Number.isInteger(holder.pid) || holder.pid <= 0)) {
    throw new Error('Invalid task lease')
  }

  lease.holders = lease.holders.filter(holder => {
    try {
      process.kill(
        holder.pid,
        0,
      )

      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }

      return false
    }
  })

  if (!lease.holders.length) {
    if (cleanup) {
      rmSync(path)
    }

    return undefined
  }

  return lease
}

function writeLease({
  path,
  lease,
}: {
  path: string
  lease: Lease
}): void {
  const temporary = `${path}.${randomUUID()}.tmp`

  try {
    writeFileSync(
      temporary,
      JSON.stringify(lease),
      { mode: 0o600 },
    )
    renameSync(
      temporary,
      path,
    )
  } finally {
    rmSync(
      temporary,
      { force: true },
    )
  }
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
    throw new HydraError({
      message: `Task ${task} is leased to another Hydra session`,
      code: 'TASK_LEASED',
    })
  }
}

export function taskLease({
  hydraId,
  task,
  actor,
  message = false,
  pid = process.pid,
  lockTimeout,
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
  const unlock = acquireLock({
    dir,
    timeout: lockTimeout,
  })

  try {
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
      throw new HydraError({
        message: `Task ${task} is being handled by ${lease.actor}; try again after its turn ends`,
        code: 'TASK_LEASED',
      })
    }

    if (isHelper({ actor }) && !helperGrant({
      state: loadHydra({ hydraId }).state,
      actor,
      task,
    })) {
      throw new HydraError({
        message: 'Helper has no live grant for this task',
        code: 'NOT_ALLOWED',
      })
    }

    const holders = [
      ...lease?.holders ?? [],
      {
        id: holder,
        pid,
      },
    ]
    writeLease({
      path,
      lease: {
        actor: owner,
        holders,
      },
    })
  } finally {
    unlock()
  }

  return () => {
    releaseTask({
      hydraId,
      task,
      actor: owner,
      holder,
      lockTimeout,
    })
  }
}

export function releaseTask({
  hydraId,
  task,
  actor,
  holder,
  lockTimeout,
}: {
  hydraId: string
  task: string
  actor: string
  holder?: string
  lockTimeout?: number
}): void {
  const dir = hydraDir({ hydraId })
  const unlock = acquireLock({
    dir,
    timeout: lockTimeout,
  })

  try {
    const path = leasePath({
      dir,
      task,
    })
    const lease = readLease({ path })

    if (lease?.actor === actor) {
      lease.holders = lease.holders.filter(entry =>
        holder ? entry.id !== holder : entry.pid !== process.pid)

      if (lease.holders.length) {
        writeLease({
          path,
          lease,
        })
      } else {
        rmSync(path)
      }
    }
  } finally {
    unlock()
  }
}
