import type { TitanSummary } from './server-titans.ts'

// The Titan list's order, as the server lists it and the page shows it: by order key, then id.
export const inListOrder = ({ titans }: { titans: TitanSummary[] }) => titans.toSorted((
  a,
  b,
) => a.order - b.order || a.id.localeCompare(b.id))
