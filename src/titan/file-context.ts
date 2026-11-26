import { join } from 'node:path'
import { titanFiles, taskFiles } from '#store/file-home.ts'
import { othrysHome } from '#store/paths.ts'

export function recordFiles({
  titanId,
  task,
}: {
  titanId: string
  task?: string
}): {
  titan: string
  task: string
  worker: string
  snapshot: string
} {
  const home = othrysHome()
  const dir = titanFiles({
    home,
    titan: titanId,
  })
  const records = task ? taskFiles({
    home,
    titan: titanId,
    task,
  }) : join(
    dir,
    'tasks',
    '<task>',
  )

  return {
    titan: join(
      dir,
      'titan.log',
    ),
    task: join(
      records,
      'task.log',
    ),
    worker: join(
      records,
      'worker.log',
    ),
    snapshot: join(
      dir,
      'snapshot.json',
    ),
  }
}

export function recordContext({
  titanId,
  task,
}: Parameters<typeof recordFiles>[0]): string {
  const files = recordFiles({
    titanId,
    task,
  })

  return `Read ${JSON.stringify(files.titan)} and the relevant ${JSON.stringify(files.task)} and ${JSON.stringify(files.worker)} directly. ${JSON.stringify(files.snapshot)} is an optional cached view; logs are authoritative and may be newer. Keep record IDs with their file scope; line numbers belong only to that file. Follow recorded transcript paths for full agent replies. Do not edit server-owned records.`
}
