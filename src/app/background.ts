import { randomUUID } from 'node:crypto'
import { logFailure, type DiagnosticContext } from './diagnostics.ts'

export function background({
  name,
  run,
  retry,
  context,
}: {
  name: string
  run(): unknown
  retry?(): void
  context?: DiagnosticContext
}): void {
  const failed = ({ error }: { error: unknown }) => {
    const operationId = randomUUID()
    logFailure({
      operation: name,
      error,
      context,
      operationId,
    })

    try {
      retry?.()
    } catch (error) {
      logFailure({
        operation: `${name} retry`,
        error,
        context,
        operationId,
      })
    }
  }

  try {
    void Promise.resolve(run()).catch(error => failed({ error }))
  } catch (error) {
    failed({ error })
  }
}
