import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { until, type Hydra } from './pnyx.ts'

export async function workerLine({
  hydra,
  key,
  line,
}: {
  hydra: Hydra
  key: string
  line: string
}) {
  const task = await hydra.task({ key })
  const dir = join(
    process.env.PNYX_HOME!,
    'runtime',
    'tasks',
    task.id,
  )
  mkdirSync(
    dir,
    { recursive: true },
  )
  const path = join(
    dir,
    'worker.log',
  )
  appendFileSync(
    path,
    `${line}\n`,
  )
  const off = statSync(path).size

  return until({
    what: 'worker line folded into its task',
    check: async () => {
      const result = await hydra.owner({
        args: [
          'task',
          'show',
          task.id,
          '--full',
        ],
      })

      return result.task.workerLog?.latest.off >= off && result.task
    },
  })
}
