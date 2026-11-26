import { join } from 'node:path'
import { hydraFiles, taskFiles } from '#store/file-home.ts'
import { othrysHome } from '#store/paths.ts'

export function recordFiles({
  hydraId,
  task,
}: {
  hydraId: string
  task?: string
}): {
  hydra: string
  task: string
  worker: string
  snapshot: string
} {
  const home = othrysHome()
  const dir = hydraFiles({
    home,
    hydra: hydraId,
  })
  const records = task ? taskFiles({
    home,
    hydra: hydraId,
    task,
  }) : join(
    dir,
    'tasks',
    '<task>',
  )

  return {
    hydra: join(
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
  hydraId,
  task,
}: Parameters<typeof recordFiles>[0]): string {
  const files = recordFiles({
    hydraId,
    task,
  })

  return `Read ${JSON.stringify(files.hydra)} and the relevant ${JSON.stringify(files.task)} and ${JSON.stringify(files.worker)} directly. ${JSON.stringify(files.snapshot)} is an optional cached view; logs are authoritative and may be newer. Keep record IDs with their file scope; line numbers belong only to that file. Follow recorded transcript paths for full agent replies. Do not edit server-owned records.`
}
