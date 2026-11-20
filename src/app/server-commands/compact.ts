import { HydraError } from '#store/errors.ts'
import type { createHost } from '#app/host.ts'
import type { CommandRequest } from './dispatch.ts'

export function compactCommand({
  ws,
  id,
  args,
  fail,
  send,
  agents,
}: CommandRequest & {
  agents: ReturnType<typeof createHost>
}) {
  if (args.length !== 1) {
    throw new HydraError({
      message: 'compact expects a card',
      code: 'VALIDATION_ERROR',
    })
  }

  void agents.compact({
    card: args[0]!,
  }).then(
    result => send({
      ws,
      message: {
        type: 'receipt',
        id,
        ...result,
      },
    }),
    (error: Error) => fail({
      error: error.message,
      code: error instanceof HydraError ? error.code : 'UNKNOWN',
    }),
  )
}
