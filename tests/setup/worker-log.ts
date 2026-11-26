import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { until, type Titan } from './othrys.ts'

export async function workerLine({
  titan,
  key,
  line,
}: {
  titan: Titan
  key: string
  line: string
}) {
  const task = await titan.task({ key })
  const dir = join(
    process.env.OTHRYS_HOME!,
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
      const result = await titan.owner({
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
