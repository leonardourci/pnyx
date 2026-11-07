import { HydraError } from '#store/errors.ts'
import type { createHost } from '#app/host.ts'
import type { CommandRequest } from './dispatch.ts'

// `compact <card> [<queued message id>]`: compacts the card's session, then sends the queued message if one is named.
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
  if (args.length < 1 || args.length > 2) {
    throw new HydraError({
      message: 'compact expects a card and an optional queued message ID',
      code: 'VALIDATION_ERROR',
    })
  }

  void agents.compact({
    card: args[0]!,
    sendNow: args[1],
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
