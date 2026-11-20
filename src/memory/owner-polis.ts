export const POLIS_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

export function ownerPolis({ state }: { state: { config?: { polis?: string } } }): string {
  return state.config?.polis ?? 'shared'
}
