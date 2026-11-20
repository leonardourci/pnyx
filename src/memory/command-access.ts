import { readOnlyCommand } from '#app/command-registry.ts'
import { requestEnv } from '#app/request-context.ts'
import { loadHydra, requireHydra } from '#app/store.ts'
import { HydraError } from '#store/errors.ts'
import { readSettings } from '#settings/store.ts'
import { requestedPolisAccess } from './access-changes.ts'
import { memoryAgent } from './poleis.ts'
import { canRead, hydraPolisConfig, DEFAULT_POLIS_ACCESS, type PolisAccess } from './polis-policy.ts'

function unavailable(): never {
  throw new HydraError({
    message: 'not found',
    code: 'NOT_FOUND',
  })
}

export function requireHydraCapability({
  hydraId,
  create,
}: {
  hydraId: string
  create?: PolisAccess
}): void {
  if (!memoryAgent()) {
    return
  }

  const caller = requestEnv().PNYX_HYDRA

  if (caller === hydraId) {
    return
  }

  if (!caller) {
    unavailable()
  }

  const state = loadHydra({ hydraId: caller }).state
  let target: { config?: Partial<PolisAccess> }

  try {
    requireHydra({ hydraId })
    target = loadHydra({ hydraId }).state
  } catch (error) {
    if (!(error instanceof HydraError && error.code === 'NOT_FOUND')) {
      throw error
    }

    if (!create) {
      unavailable()
    }

    target = { config: create }
  }

  const poleis = readSettings().settings.poleis
  const access = hydraPolisConfig({ state: target })
  const required = new Set([
    access.polis,
    ...access.readPoleis.filter(polis => canRead({
      hydraId,
      state: target,
      poleis,
      polis,
    })),
  ])

  if (![...required].every(polis => canRead({
    hydraId: caller,
    state,
    poleis,
    polis,
  }))) {
    unavailable()
  }
}

export function requireCommandMemoryAccess({
  name,
  args,
  positionals,
  values,
  hydraId,
}: {
  name: string
  args: string[]
  positionals: string[]
  values: Record<string, unknown>
  hydraId: string
}): void {
  if (!memoryAgent() || readOnlyCommand({
    name,
    args,
    positionals,
    values,
  })) {
    return
  }

  requireHydraCapability({ hydraId })

  if (name === 'task' && typeof values['to-hydra'] === 'string') {
    requireHydraCapability({ hydraId: values['to-hydra'] })
  }

  if (name === 'hydra' && positionals[0] === 'create') {
    const id = positionals[1]

    if (id) {
      requireHydraCapability({
        hydraId: id,
        create: requestedPolisAccess({
          reads: typeof values['read-poleis'] === 'string' ? values['read-poleis'] : undefined,
          polis: typeof values.polis === 'string' ? values.polis : undefined,
        }) ?? DEFAULT_POLIS_ACCESS,
      })
    }
  }
}
