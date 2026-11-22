import { join } from 'node:path'
import { hydraFiles, taskFiles } from '#store/file-home.ts'
import { pnyxHome } from '#store/paths.ts'

export function recordContext({
  hydraId,
  task,
}: {
  hydraId: string
  task?: string
}): string {
  const home = pnyxHome()
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

  return `Read ${JSON.stringify(join(
    dir,
    'hydra.log',
  ))} and the relevant ${JSON.stringify(join(
    records,
    'task.log',
  ))} and ${JSON.stringify(join(
    records,
    'worker.log',
  ))} directly. ${JSON.stringify(join(
    dir,
    'snapshot.json',
  ))} is an optional cached view; logs are authoritative and may be newer. Keep record IDs with their file scope; line numbers belong only to that file. Follow recorded transcript paths for full agent replies. Do not edit server-owned records.`
}
