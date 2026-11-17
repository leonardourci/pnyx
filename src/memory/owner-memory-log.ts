import { HydraError } from '#store/errors.ts'
import { SPACE_NAME } from './space-policy.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Learning, LearningChange } from './learnings.ts'
import type { ProjectMemoryEvent } from './project-memory.ts'
import { pnyxHome } from '#store/paths.ts'

// One replacement or removal of an owner memory key; the log is only appended, so every old version stays.
export interface OwnerEntry {
  v: 1
  seq: number
  at: string
  actor: string
  reason?: string
  confirmed?: string
  learning?: LearningChange
  importedLearnings?: Learning[]
  key: string
  before: string | null
  after: string | null
  // One source entry commits both sides; destination replay imports its entry.
  spaceMove?: {
    space: string
    entry: OwnerEntry
  }
  projectMove?: {
    project: string
    event: ProjectMemoryEvent
  }
}

export function ownerMemoryLogPath({ space = 'shared' }: { space?: string } = {}) {
  const owner = join(
    pnyxHome(),
    'owner',
  )
  const folder = space === 'shared' ? owner : join(
    owner,
    'spaces',
    space,
  )

  return join(
    folder,
    'memory.jsonl',
  )
}

function readLogEntries({ space = 'shared' }: { space?: string } = {}): {
  entries: OwnerEntry[]
  corrupt: boolean
} {
  let text = ''

  try {
    text = readFileSync(
      ownerMemoryLogPath({ space }),
      'utf8',
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const entries: OwnerEntry[] = []
  let corrupt = Boolean(text) && !text.endsWith('\n')

  const completeLines = text.split('\n').slice(
    0,
    -1,
  )
    .filter(Boolean)

  for (const line of completeLines) {
    let entry: OwnerEntry | undefined

    try {
      entry = JSON.parse(line) as OwnerEntry
    } catch {
      entry = undefined
    }

    if (typeof entry?.key !== 'string' || (entry.after !== null && typeof entry.after !== 'string')) {
      corrupt = true
      continue
    }

    if (entry.projectMove && (entry.key !== 'learnings' || typeof entry.projectMove.project !== 'string'
      || entry.projectMove.event?.key !== 'learnings' || typeof entry.projectMove.event.after !== 'string')) {
      corrupt = true
      continue
    }

    if (entry.spaceMove && (!SPACE_NAME.test(entry.spaceMove.space)
      || entry.spaceMove.entry?.key !== entry.key || typeof entry.spaceMove.entry.after !== 'string'
      || !Number.isInteger(entry.spaceMove.entry.seq) || entry.spaceMove.entry.spaceMove)) {
      corrupt = true
      continue
    }

    entries.push(entry)
  }

  return {
    entries,
    corrupt,
  }
}

function ownerLogSpaces(): string[] {
  let names: string[] = []

  try {
    names = readdirSync(join(
      pnyxHome(),
      'owner',
      'spaces',
    ))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  return [
    'shared',
    ...names.filter(name => name !== 'shared' && SPACE_NAME.test(name)),
  ]
}

export function ownerProjectMoves({ id }: { id: string }) {
  return ownerLogSpaces().flatMap(space => {
    const log = readLogEntries({ space })

    if (log.corrupt) {
      throw new HydraError({
        message: 'Owner memory has an unreadable line; inspect its log before reading project moves',
        code: 'LOG_CORRUPT',
      })
    }

    return log.entries.flatMap(entry => {
      if (entry.projectMove?.project === id) {
        return [entry.projectMove.event]
      }

      return []
    })
  })
}

export function readOwnerEntries({ space = 'shared' }: { space?: string } = {}) {
  const result = readLogEntries({ space })

  for (const source of ownerLogSpaces()) {
    if (source === space) {
      continue
    }

    const log = readLogEntries({ space: source })

    for (const entry of log.entries) {
      if (entry.spaceMove?.space === space) {
        result.entries.push(entry.spaceMove.entry)
      }
    }
  }

  result.entries.sort((
    left,
    right,
  ) => left.seq - right.seq)

  return result
}
