import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'

const requests = new AsyncLocalStorage<{
  id: string
  open: boolean
}>()

export const logRequestId = () => {
  const request = requests.getStore()

  return request?.open ? request.id : undefined
}

export async function withLogRequest<T>({
  run,
  requestId = randomUUID(),
  response,
}: {
  run(): Promise<T>
  requestId?: string
  response?: Pick<ServerResponse, 'once'>
}): Promise<T> {
  const request = {
    id: requestId,
    open: true,
  }
  response?.once(
    'close',
    () => {
      request.open = false
    },
  )

  return requests.run(
    request,
    async () => {
      try {
        return await run()
      } finally {
        request.open = false
      }
    },
  )
}
