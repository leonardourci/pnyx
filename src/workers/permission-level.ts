import type { Harness } from './providers.ts'
import type { Card } from '#tasks/model.ts'
import type { HydraState } from '#app/model.ts'
import { hydraMode } from '#hydra/hydra.ts'
import { findOption } from './controls.ts'
import { PROVIDERS, harnessOf, providerIdOf } from './providers.ts'
import { hydraActor } from '#app/request-context.ts'
import { HydraError } from '#store/errors.ts'

const PERMISSION_LEVELS: Record<Harness, Record<string, number>> = {
  claude: {
    plan: 0,
    default: 1,
    acceptEdits: 2,
    auto: 3,
    bypassPermissions: 4,
  },
  codex: {
    untrusted: 0,
    'on-request': 1,
    never: 4,
    bypassPermissions: 4,
  },
}

export function workerMode({
  state,
  harness,
  mode,
}: {
  state: HydraState
  harness: Harness
  mode?: string
}): string | undefined {
  if (mode !== undefined) {
    return mode
  }

  const inherited = hydraMode({ state })

  if (inherited && inherited !== 'plan' && findOption({
    provider: providerIdOf({ harness }),
    setting: 'mode',
    value: inherited,
    hosted: true,
  })) {
    return inherited
  }

  return undefined
}

// A start Hydra asks for may keep or lower the worker's permission level; only the owner raises it.
export function requireOwnerToRaise({
  state,
  actor,
  harness,
  before,
  after,
}: {
  state: HydraState
  actor?: string
  harness: Harness
  before?: string
  after?: string
}): void {
  const hydraRaises = after !== undefined && hydraActor({ actor }) && raisesPermission({
    harness,
    before: workerMode({
      state,
      harness,
      mode: before,
    }),
    after,
  })

  if (hydraRaises) {
    throw new HydraError({
      message: 'Only the owner can raise a worker’s permission level',
      code: 'OWNER_ONLY',
    })
  }
}

export function agentPermissionNeedsOwner({
  card,
  value,
}: {
  card: Card
  value: string
}): boolean {
  const harness = harnessOf({ provider: card.agent?.provider })

  return raisesPermission({
    harness,
    before: card.settings?.mode,
    after: value,
  })
}

export function raisesPermission({
  harness,
  before,
  after,
  beforeHarness = harness,
}: {
  harness: Harness
  before?: string
  after?: string
  beforeHarness?: Harness
}): boolean {
  if (before === after && beforeHarness === harness) {
    return false
  }

  const beforeDefault = PROVIDERS[beforeHarness].defaultMode
  const afterDefault = PROVIDERS[harness].defaultMode
  const previous = PERMISSION_LEVELS[beforeHarness][before ?? beforeDefault]
  const next = PERMISSION_LEVELS[harness][after ?? afterDefault]

  // An unknown mode cannot prove that permissions stay the same or decrease.
  return previous === undefined || next === undefined || next > previous
}
