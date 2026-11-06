import type { Harness } from './providers.ts'
import type { Card } from '#tasks/model.ts'
import type { HydraState } from '#app/model.ts'
import { hydraMode } from '#hydra/hydra.ts'
import { findOption } from './controls.ts'
import { PROVIDERS, harnessOf, providerIdOf } from './providers.ts'

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
