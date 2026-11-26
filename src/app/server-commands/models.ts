import { TitanError } from '#store/errors.ts'
import { knownHarness } from '#workers/providers.ts'
import type { createHost } from '#app/host.ts'
import type { CommandRequest } from './dispatch.ts'

// `models claude|codex [<account>] [--refresh]`: the models the harness offers for the picker.
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
  const refresh = args.at(-1) === '--refresh'
  const positional = refresh ? args.slice(
    0,
    -1,
  ) : args
  const harness = knownHarness({ name: positional[0] })

  if (positional.length < 1 || positional.length > 2 || !harness) {
    throw new TitanError({
      message: 'models expects claude or codex, an optional account name and an optional --refresh',
      code: 'VALIDATION_ERROR',
    })
  }

  void agents.models({
    harness,
    account: positional[1],
    refresh,
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
      error: error instanceof TitanError ? error.message : 'Harness model catalog unavailable. Reload to try again.',
      code: error instanceof TitanError ? error.code : 'CATALOG_UNAVAILABLE',
    }))
}
