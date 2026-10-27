import { randomUUID } from 'node:crypto'
import { helperGrant } from './route.ts'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HydraError } from '../core/model.ts'
import { acquireLock, loadHydra } from '../store/hydra-store.ts'
import { hydraDir } from '../app/home-migration.ts'

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

function readLease({ path }: { path: string }): Lease | undefined {
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
    rmSync(path)

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
  pid = process.pid,
  lockTimeout,
}: {
  hydraId: string
  task: string
  actor: string
  pid?: number
  lockTimeout?: number
}): () => void {
  const holder = randomUUID()
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

    if (lease && lease.actor !== actor) {
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
        actor,
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
      actor,
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
