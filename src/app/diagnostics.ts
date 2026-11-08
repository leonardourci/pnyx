import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'

const FAILURE_INSPECT_DEPTH = 2

export interface DiagnosticContext {
  hydraId: string
  taskId?: string
  sessionId?: string
  correlationId?: string
  eventSeq?: number
}

export function logFailure({
  operation,
  error,
  context,
  operationId = randomUUID(),
}: {
  operation: string
  error: unknown
  context?: DiagnosticContext
  operationId?: string
}): void {
  const failure: {
    name?: string
    message: string
    code?: string
    stack?: string
  } = { message: '' }

  if (error instanceof Error) {
    failure.name = error.name
    failure.message = error.message
    failure.stack = error.stack

    if ('code' in error && typeof error.code === 'string') {
      failure.code = error.code
    }
  } else {
    failure.message = typeof error === 'string' ? error : inspect(
      error,
      {
        customInspect: false,
        depth: FAILURE_INSPECT_DEPTH,
      },
    )
  }

  console.error(JSON.stringify({
    v: 1,
    at: new Date().toISOString(),
    level: 'error',
    pid: process.pid,
    operation,
    operationId,
    hydraId: context?.hydraId,
    taskId: context?.taskId,
    sessionId: context?.sessionId,
    correlationId: context?.correlationId,
    eventSeq: context?.eventSeq,
    error: failure,
  }))
}
