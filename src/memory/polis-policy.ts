export const POLIS_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
export const DEFAULT_POLIS_ACCESS = {
  polis: 'shared',
  readPoleis: ['shared'],
}
export type PolisAccess = {
  polis: string
  readPoleis: string[]
}
export type Poleis = Record<string, { readers: string[] }>

export function hydraPolisConfig({ state }: {
  state: { config?: Partial<PolisAccess> }
}): PolisAccess {
  return {
    polis: state.config?.polis ?? DEFAULT_POLIS_ACCESS.polis,
    readPoleis: state.config?.readPoleis ?? DEFAULT_POLIS_ACCESS.readPoleis,
  }
}

export function canRead({
  hydraId,
  state,
  poleis,
  polis,
}: {
  hydraId: string
  state: { config?: Partial<PolisAccess> }
  poleis: Poleis
  polis: string
}): boolean {
  const access = hydraPolisConfig({ state })
  const readers = Object.hasOwn(
    poleis,
    polis,
  ) ? poleis[polis]?.readers : undefined
  const listed = Boolean(readers?.includes('*') || readers?.includes(hydraId))

  return access.readPoleis.includes(polis) && listed
}

export function canWrite({
  hydraId,
  state,
  poleis,
  polis,
}: Parameters<typeof canRead>[0]): boolean {
  return hydraPolisConfig({ state }).polis === polis && canRead({
    hydraId,
    state,
    poleis,
    polis,
  })
}
