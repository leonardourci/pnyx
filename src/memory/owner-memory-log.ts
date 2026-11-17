import { HydraError } from '#store/errors.ts'
import { POLIS_NAME } from './polis-policy.ts'
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
  polisMove?: {
    polis: string
    entry: OwnerEntry
  }
  projectMove?: {
    project: string
    event: ProjectMemoryEvent
  }
}

export function ownerRevision({
  polis,
  revision,
}: {
  polis: string
  revision: number
}): string | number {
  return polis === 'shared' ? revision : `${polis}:${revision}`
}

export function ownerMemoryLogPath({ polis = 'shared' }: { polis?: string } = {}) {
  const owner = join(
    pnyxHome(),
    'owner',
  )
  const folder = polis === 'shared' ? owner : join(
    owner,
    'poleis',
    polis,
  )

  return join(
    folder,
    'memory.jsonl',
  )
}

function readLogEntries({ polis = 'shared' }: { polis?: string } = {}): {
  entries: OwnerEntry[]
  corrupt: boolean
} {
  let text = ''

  try {
    text = readFileSync(
      ownerMemoryLogPath({ polis }),
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

    if (typeof entry?.key !== 'string' || !Number.isSafeInteger(entry.seq) || entry.seq < 1
      || (entry.after !== null && typeof entry.after !== 'string')) {
      corrupt = true
      continue
    }

    if (entry.projectMove && (entry.key !== 'learnings' || typeof entry.projectMove.project !== 'string'
      || entry.projectMove.event?.key !== 'learnings' || typeof entry.projectMove.event.after !== 'string')) {
      corrupt = true
      continue
    }

    if (entry.polisMove && (typeof entry.polisMove.polis !== 'string' || !POLIS_NAME.test(entry.polisMove.polis)
      || entry.polisMove.polis === polis || entry.after !== null || entry.projectMove
      || entry.polisMove.entry?.key !== entry.key || typeof entry.polisMove.entry.after !== 'string'
      || !Number.isSafeInteger(entry.polisMove.entry.seq) || entry.polisMove.entry.seq < 1
      || entry.polisMove.entry.polisMove || entry.polisMove.entry.projectMove)) {
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

function ownerLogPoleis(): string[] {
  let names: string[] = []

  try {
    names = readdirSync(join(
      pnyxHome(),
      'owner',
      'poleis',
    ))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  return [
    'shared',
    ...names.filter(name => name !== 'shared' && POLIS_NAME.test(name)),
  ]
}

export function ownerProjectMoves({ id }: { id: string }) {
  return ownerLogPoleis().flatMap(polis => {
    const log = readLogEntries({ polis })

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

export function readOwnerEntries({ polis = 'shared' }: { polis?: string } = {}) {
  const result = readLogEntries({ polis })

  for (const source of ownerLogPoleis()) {
    if (source === polis) {
      continue
    }

    const log = readLogEntries({ polis: source })

    for (const entry of log.entries) {
      if (entry.polisMove?.polis === polis) {
        result.entries.push(entry.polisMove.entry)
      }
    }
  }

  result.entries.sort((
    left,
    right,
  ) => left.seq - right.seq)

  return result
}
