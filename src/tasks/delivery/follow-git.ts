import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { commonDir } from '#projects/git.ts'
import { log } from '#app/diagnostics.ts'
import type { HydraState } from '#app/model.ts'
import { workingTask } from './follow-schedule.ts'
import { followedLinks } from './follow.ts'

export function followGit({ changed }: { changed({ task }: { task: string }): void }) {
  const watching = new Map<string, {
    folder: string
    cancelled: boolean
    watcher?: FSWatcher
  }>()

  const close = () => {
    for (const entry of watching.values()) {
      entry.cancelled = true
      entry.watcher?.close()
    }

    watching.clear()
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
        entry.cancelled = true
        entry.watcher?.close()
        watching.delete(task)
      }
    }

    for (const [
      task,
      folder,
    ] of wanted) {
      if (watching.has(task)) {
        continue
      }

      const entry: {
        folder: string
        cancelled: boolean
        watcher?: FSWatcher
      } = {
        folder,
        cancelled: false,
      }
      watching.set(
        task,
        entry,
      )
      pending.push((async () => {
        try {
          const directory = await commonDir({ cwd: folder })

          if (entry.cancelled || !directory) {
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
            () => changed({ task }),
          )
          entry.watcher.on(
            'error',
            error => {
              entry.watcher?.close()
              log({
                level: 'warn',
                operation: 'follow.git',
                taskId: task,
                error,
              })
            },
          )
        } catch (error) {
          // The active PR poll still observes a push when native refs cannot be watched.
          log({
            level: 'warn',
            operation: 'follow.git',
            taskId: task,
            error,
          })
        }
      })())
    }

    await Promise.all(pending)
  }

  return {
    reconcile,
    close,
  }
}
