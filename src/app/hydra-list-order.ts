import type { HydraSummary } from './server-hydras.ts'

// The Hydra list's order, as the server lists it and the page shows it: by order key, then id.
export const inListOrder = ({ hydras }: { hydras: HydraSummary[] }) => hydras.toSorted((
  a,
  b,
) => a.order - b.order || a.id.localeCompare(b.id))
