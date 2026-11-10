import { randomUUID } from 'node:crypto'
import { log, type LogLine } from './diagnostics.ts'

type LogIds = Pick<LogLine, 'hydraId' | 'taskId' | 'sessionId' | 'correlationId' | 'eventSeq'>

export function background({
  name,
  run,
  retry,
  context,
}: {
  name: string
  run(): unknown
  retry?(): void
  context?: LogIds
}): void {
  const failed = ({ error }: { error: unknown }) => {
    const operationId = randomUUID()
    log({
      level: 'error',
      operation: name,
      error,
      operationId,
      ...context,
    })

    try {
      retry?.()
    } catch (error) {
      log({
        level: 'error',
        operation: `${name} retry`,
        error,
        operationId,
        ...context,
      })
    }
  }

  try {
    void Promise.resolve(run()).catch(error => failed({ error }))
  } catch (error) {
    failed({ error })
  }
}
