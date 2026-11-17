import type { HydraState } from '#app/model.ts'

export const SPACE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
export const DEFAULT_MEMORY_ACCESS = {
  reads: ['shared'],
  write: 'shared',
}
export type MemoryAccess = {
  reads: string[]
  write: string
}
export type MemorySpaces = Record<string, { readers: string[] }>

export function canRead({
  hydraId,
  state,
  spaces,
  space,
}: {
  hydraId: string
  state: Pick<HydraState, 'config'>
  spaces: MemorySpaces
  space: string
}): boolean {
  const access = state.config?.memory ?? DEFAULT_MEMORY_ACCESS
  const readers = Object.hasOwn(
    spaces,
    space,
  ) ? spaces[space]?.readers : undefined

  return access.reads.includes(space) && Boolean(readers?.includes('*') || readers?.includes(hydraId))
}

export function canWrite({
  hydraId,
  state,
  spaces,
  space,
}: Parameters<typeof canRead>[0]): boolean {
  const write = (state.config?.memory ?? DEFAULT_MEMORY_ACCESS).write

  return write === space && canRead({
    hydraId,
    state,
    spaces,
    space,
  })
}
