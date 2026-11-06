import { HydraError } from '#store/errors.ts'
import { knownHarness } from '#workers/providers.ts'
import type { createHost } from '#app/host.ts'
import type { CommandRequest } from './dispatch.ts'

// `models claude|codex [<account>]`: the models the harness offers for the picker.
export function modelsCommand({
  ws,
  id,
  args,
  fail,
  send,
  agents,
}: CommandRequest & {
  agents: ReturnType<typeof createHost>
}) {
  const harness = knownHarness({ name: args[0] })

  if (args.length < 1 || args.length > 2 || !harness) {
    throw new HydraError({
      message: 'models expects claude or codex and an optional account name',
      code: 'VALIDATION_ERROR',
    })
  }

  void agents.models({
    harness,
    account: args[1],
  })
    .then(models => send({
      ws,
      message: {
        type: 'receipt',
        id,
        models,
      },
    }))
    .catch((error: Error) => fail({
      error: error instanceof HydraError ? error.message : 'Harness model catalog unavailable. Reopen the picker to retry.',
      code: error instanceof HydraError ? error.code : 'CATALOG_UNAVAILABLE',
    }))
}
