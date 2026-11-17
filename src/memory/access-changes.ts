import { HydraError } from '#store/errors.ts'
import type { HydraState } from '#app/model.ts'
import type { Settings } from '#settings/model.ts'
import { canRead, DEFAULT_MEMORY_ACCESS, SPACE_NAME, type MemoryAccess } from './space-policy.ts'

export function widensHydraReads({
  before,
  after,
}: {
  before?: MemoryAccess
  after: MemoryAccess
}): boolean {
  const reads = (before ?? DEFAULT_MEMORY_ACCESS).reads

  return after.reads.some(space => !reads.includes(space))
}

export function widensSpaceReaders({
  before,
  after,
  hydras,
}: {
  before: Settings
  after: Settings
  hydras: {
    id: string
    state: HydraState
  }[]
}): boolean {
  for (const [
    space,
    access,
  ] of Object.entries(after.memorySpaces)) {
    const previous = before.memorySpaces[space]?.readers ?? []

    if (!previous.includes('*') && access.readers.some(reader => !previous.includes(reader))) {
      return true
    }
  }

  const projects = new Set([
    ...Object.keys(before.projectSpaces),
    ...Object.keys(after.projectSpaces),
  ])

  for (const project of projects) {
    const source = before.projectSpaces[project] ?? 'shared'
    const destination = after.projectSpaces[project] ?? 'shared'

    if (source === destination) {
      continue
    }

    if (sharesWithMore({
      source,
      destination,
      before,
      after,
      hydras,
    })) {
      return true
    }
  }

  return false
}

export function sharesWithMore({
  source,
  destination,
  before,
  after = before,
  hydras,
}: {
  source: string
  destination: string
  before: Settings
  after?: Settings
  hydras: {
    id: string
    state: HydraState
  }[]
}): boolean {
  const futureSharedReader = destination === 'shared' && source !== 'shared'
    && after.memorySpaces.shared?.readers.includes('*')

  return Boolean(futureSharedReader) || hydras.some(({
    id,
    state,
  }) =>
    canRead({
      hydraId: id,
      state,
      spaces: after.memorySpaces,
      space: destination,
    })
    && !canRead({
      hydraId: id,
      state,
      spaces: before.memorySpaces,
      space: source,
    }))
}

export function requestedMemoryAccess({
  current = DEFAULT_MEMORY_ACCESS,
  reads,
  write,
}: {
  current?: MemoryAccess
  reads?: string | boolean
  write?: string | boolean
}): MemoryAccess | undefined {
  if (reads === undefined && write === undefined) {
    return undefined
  }

  const requestedReads = reads === undefined ? current.reads : String(reads).split(',')
  const nextReads = reads === '' ? [] : requestedReads
  const nextWrite = String(write ?? current.write)

  if (!SPACE_NAME.test(nextWrite) || !nextReads.every(space => SPACE_NAME.test(space))
    || new Set(nextReads).size !== nextReads.length) {
    throw new HydraError({
      message: 'Memory spaces use lowercase letters, digits and dashes; reads is a comma-separated list',
      code: 'VALIDATION_ERROR',
    })
  }

  return {
    reads: nextReads,
    write: nextWrite,
  }
}
