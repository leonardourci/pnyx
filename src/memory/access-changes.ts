import { HydraError } from '#store/errors.ts'
import type { HydraState } from '#app/model.ts'
import type { Settings } from '#settings/model.ts'
import { canRead, DEFAULT_POLIS_ACCESS, POLIS_NAME, type PolisAccess } from './polis-policy.ts'

export function widensPolisReads({
  before,
  after,
}: {
  before?: PolisAccess
  after: PolisAccess
}): boolean {
  const reads = (before ?? DEFAULT_POLIS_ACCESS).readPoleis

  return after.readPoleis.some(polis => !reads.includes(polis))
}

export function widensPolisReaders({
  before,
  after,
}: {
  before: Settings
  after: Settings
}): boolean {
  for (const [
    polis,
    access,
  ] of Object.entries(after.poleis)) {
    const previous = before.poleis[polis]?.readers ?? []

    if (!previous.includes('*') && access.readers.some(reader => !previous.includes(reader))) {
      return true
    }
  }

  return false
}

export function sharesWithMore({
  source,
  destination,
  before,
  hydras,
}: {
  source: string
  destination: string
  before: Settings
  hydras: {
    id: string
    state: HydraState
  }[]
}): boolean {
  const existingHydras = new Set(hydras.map(hydra => hydra.id))
  const sharedReaders = before.poleis.shared?.readers ?? []
  const futureSharedReader = destination === 'shared' && source !== 'shared'
    && sharedReaders.some(reader => reader === '*' || !existingHydras.has(reader))

  return futureSharedReader || hydras.some(({
    id,
    state,
  }) =>
    canRead({
      hydraId: id,
      state,
      poleis: before.poleis,
      polis: destination,
    })
    && !canRead({
      hydraId: id,
      state,
      poleis: before.poleis,
      polis: source,
    }))
}

export function requestedPolisAccess({
  current = DEFAULT_POLIS_ACCESS,
  reads,
  polis,
}: {
  current?: PolisAccess
  reads?: string | boolean
  polis?: string | boolean
}): PolisAccess | undefined {
  if (reads === undefined && polis === undefined) {
    return undefined
  }

  let readPoleis = current.readPoleis

  if (reads !== undefined) {
    readPoleis = reads === '' ? [] : String(reads).split(',')
  }

  const nextPolis = String(polis ?? current.polis)
  const validNames = POLIS_NAME.test(nextPolis) && readPoleis.every(name => POLIS_NAME.test(name))
  const uniqueReads = new Set(readPoleis).size === readPoleis.length

  if (!validNames || !uniqueReads) {
    throw new HydraError({
      message: 'Polis names use lowercase letters, digits and dashes; read-poleis is a comma-separated list',
      code: 'VALIDATION_ERROR',
    })
  }

  return {
    polis: nextPolis,
    readPoleis,
  }
}
