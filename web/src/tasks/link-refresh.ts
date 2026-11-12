import { useEffect } from 'react'
import type { Command } from '#web-app/connection.ts'
import { log } from '#web-app/log.ts'

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

      command({
        name: 'task',
        args: [
          'refresh-links',
          task,
        ],
      }).catch(error => log({
        level: 'warn',
        operation: 'page.links-refresh',
        taskId: task,
        error,
      }))
    },
    [
      task,
      command,
      connected,
    ],
  )
}
