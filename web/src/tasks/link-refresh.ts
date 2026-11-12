import { useEffect } from 'react'
import type { Command } from '#web-app/connection.ts'
import { log } from '#web-app/log.ts'

const refreshing = new Map<string, Promise<void>>()

// An open task and its review panel both ask on mount and on reconnect; one request per task runs at a time.
export function refreshLinks({
  task,
  command,
}: {
  task: string
  command: Command
}): Promise<void> {
  const pending = refreshing.get(task)

  if (pending) {
    return pending
  }

  const request = command({
    name: 'task',
    args: [
      'refresh-links',
      task,
    ],
  }).then(
    () => {},
    error => log({
      level: 'warn',
      operation: 'page.links-refresh',
      taskId: task,
      error,
    }),
  )
    .finally(() => refreshing.delete(task))
  refreshing.set(
    task,
    request,
  )

  return request
}

// Reads the task's pull requests when the owner opens it, and again after a reconnect.
export function useLinkRefresh({
  task,
  command,
  connected,
}: {
  task: string
  command: Command
  connected: boolean
}) {
  useEffect(
    () => {
      if (!connected) {
        return
      }

      // Its failure is logged inside, and the minute poll still reads the links.
      void refreshLinks({
        task,
        command,
      })
    },
    [
      task,
      command,
      connected,
    ],
  )
}
