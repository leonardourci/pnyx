import type { TitanSummary } from './server-hydras.ts'

// The Titan list's order, as the server lists it and the page shows it: by order key, then id.
export const inListOrder = ({ hydras }: { hydras: TitanSummary[] }) => hydras.toSorted((
  a,
  b,
) => a.order - b.order || a.id.localeCompare(b.id))
