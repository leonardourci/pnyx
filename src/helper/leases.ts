import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HydraError } from '../core/model.ts'
import { acquireLock, hydraDir, loadHydra } from '../store/hydra-store.ts'

interface Lease {
  actor: string
  pid: number
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

  if (!Number.isInteger(lease.pid) || lease.pid <= 0 || typeof lease.actor !== 'string') {
    throw new Error('Invalid task lease')
  }

  try {
    process.kill(
      lease.pid,
      0,
    )

    return lease
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error
    }

    rmSync(path)

    return undefined
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
}: {
  hydraId: string
  task: string
  actor: string
  pid?: number
}): () => void {
  let claimed = false
  const dir = hydraDir({ hydraId })
  const unlock = acquireLock({ dir })

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

    if (!lease) {
      if (isHelper({ actor })) {
        const batch = loadHydra({ hydraId }).state.helper?.runs[actor.slice('helper:'.length)]

        if (!batch || batch.error || !batch.tasks.includes(task)) {
          throw new HydraError({
            message: 'Helper has no live grant for this task',
            code: 'NOT_ALLOWED',
          })
        }
      }

      writeFileSync(
        path,
        JSON.stringify({
          actor,
          pid,
        }),
        {
          flag: 'wx',
          mode: 0o600,
        },
      )
      claimed = true
    }
  } finally {
    unlock()
  }

  return () => {
    if (!claimed) {
      return
    }

    releaseTask({
      hydraId,
      task,
      actor,
    })
  }
}

export function releaseTask({
  hydraId,
  task,
  actor,
}: {
  hydraId: string
  task: string
  actor: string
}): void {
  const dir = hydraDir({ hydraId })
  const unlock = acquireLock({ dir })

  try {
    const path = leasePath({
      dir,
      task,
    })
    const lease = readLease({ path })

    if (lease?.actor === actor) {
      rmSync(path)
    }
  } finally {
    unlock()
  }
}
