import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

const requests = new AsyncLocalStorage<string>()

export const logCorrelation = () => requests.getStore()

export function withLogRequest<T>({
  run,
  correlationId = randomUUID(),
}: {
  run(): T
  correlationId?: string
}): T {
  return requests.run(
    correlationId,
    run,
  )
}
