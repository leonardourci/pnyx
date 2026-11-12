import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { git } from '#projects/git.ts'
import { log } from '#app/diagnostics.ts'
import type { HydraState } from '#app/model.ts'
import { workingTask } from './follow-schedule.ts'
import { followedLinks } from './follow.ts'

// A copy whose refs cannot be watched is tried again after this long, not on every pump.
export const GIT_RETRY_MS = 60_000

const BRANCH_HEAD = 'ref: refs/heads/'

type RefWatch = {
  folder: string
  cancelled: boolean
  watcher?: FSWatcher
  retryAt?: number
  logged?: boolean
}

const stop = ({ entry }: { entry: RefWatch }) => {
  entry.cancelled = true
  entry.watcher?.close()
}

// Copies of one project share its refs folder, so a change counts only when it names this copy's
// branch or a remote branch of the same name. A detached copy or an unnamed change counts always.
const ownRef = ({
  filename,
  branch,
}: {
  filename: string | null
  branch: string | undefined
}) => {
  if (!branch || !filename) {
    return true
  }

  const remoteBranch = filename.startsWith('remotes/') && filename.endsWith(`/${branch}`)

  return filename === `heads/${branch}` || remoteBranch
}

async function refsOf({ folder }: { folder: string }) {
  const found = await git({
    cwd: folder,
    args: [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
      '--git-dir',
    ],
  })
  const [
    directory,
    own,
  ] = found.out.split('\n')

  if (!found.ok || !directory || !own) {
    throw new Error(found.err || `${folder} is not a Git repository`)
  }

  const head = readFileSync(
    join(
      own,
      'HEAD',
    ),
    'utf8',
  ).trim()

  return {
    directory,
    branch: head.startsWith(BRANCH_HEAD) ? head.slice(BRANCH_HEAD.length) : undefined,
  }
}

export function followGit({ changed }: { changed({ task }: { task: string }): void }) {
  const watching = new Map<string, RefWatch>()

  const close = () => {
    for (const entry of watching.values()) {
      stop({ entry })
    }

    watching.clear()
  }

  const failed = ({
    task,
    entry,
    error,
  }: {
    task: string
    entry: RefWatch
    error: unknown
  }) => {
    entry.watcher?.close()
    entry.watcher = undefined
    entry.retryAt = Date.now() + GIT_RETRY_MS

    if (entry.logged) {
      return
    }

    entry.logged = true
    // The active PR poll still observes a push when native refs cannot be watched.
    log({
      level: 'warn',
      operation: 'follow.git',
      taskId: task,
      error,
    })
  }

  const start = async ({
    task,
    entry,
  }: {
    task: string
    entry: RefWatch
  }) => {
    entry.retryAt = undefined

    try {
      const {
        directory,
        branch,
      } = await refsOf({ folder: entry.folder })

      if (entry.cancelled) {
        return
      }

      entry.watcher = watch(
        join(
          directory,
          'refs',
        ),
        {
          recursive: true,
          persistent: false,
        },
        (
          _event,
          filename,
        ) => {
          if (ownRef({
            filename,
            branch,
          })) {
            changed({ task })
          }
        },
      )
      entry.watcher.on(
        'error',
        error => failed({
          task,
          entry,
          error,
        }),
      )
    } catch (error) {
      failed({
        task,
        entry,
        error,
      })
    }
  }

  const reconcile = async ({ state }: { state: HydraState }) => {
    const pending: Promise<void>[] = []
    const wanted = new Map(followedLinks({ state }).flatMap(({ card }) => {
      const working = workingTask({ card })
      const folder = card.copy?.path ?? card.folder

      return working && folder ? [
        [
          card.id,
          folder,
        ] as const,
      ] : []
    }))

    for (const [
      task,
      entry,
    ] of watching) {
      if (wanted.get(task) !== entry.folder) {
        stop({ entry })
        watching.delete(task)
      }
    }

    for (const [
      task,
      folder,
    ] of wanted) {
      const existing = watching.get(task)
      const retry = existing?.retryAt !== undefined && Date.now() >= existing.retryAt

      if (existing && !retry) {
        continue
      }

      const entry: RefWatch = existing ?? {
        folder,
        cancelled: false,
      }
      watching.set(
        task,
        entry,
      )
      pending.push(start({
        task,
        entry,
      }))
    }

    await Promise.all(pending)
  }

  return {
    reconcile,
    close,
  }
}
