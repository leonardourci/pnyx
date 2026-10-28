import type { Link } from './model.ts'

export function isStaleLink({
  current,
  next,
}: {
  current: Link | undefined
  next: Link
}): boolean {
  return current?.checkedAt !== undefined
    && next.checkedAt !== undefined
    && next.checkedAt < current.checkedAt
}
