import { TitanError } from '#store/errors.ts'
import { POLIS_NAME } from './owner-polis.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Learning, LearningChange } from './learnings.ts'
import type { ProjectMemoryEvent } from './project-memory.ts'
import { othrysHome } from '#store/paths.ts'

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
    othrysHome(),
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
  let previousSequence = 0

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
      break
    }

    if (entry.projectMove && (entry.key !== 'learnings' || typeof entry.projectMove.project !== 'string'
      || entry.projectMove.event?.key !== 'learnings' || typeof entry.projectMove.event.after !== 'string')) {
      corrupt = true
      break
    }

    if (entry.polisMove && (typeof entry.polisMove.polis !== 'string' || !POLIS_NAME.test(entry.polisMove.polis)
      || entry.polisMove.polis === polis || entry.after !== null || entry.projectMove
      || entry.polisMove.entry?.key !== entry.key || typeof entry.polisMove.entry.after !== 'string'
      || !Number.isSafeInteger(entry.polisMove.entry.seq) || entry.polisMove.entry.seq < 1
      || entry.polisMove.entry.polisMove || entry.polisMove.entry.projectMove)) {
      corrupt = true
      break
    }

    const sequence = entry.seq

    if (sequence <= previousSequence) {
      corrupt = true
      // Remove the earlier physical records at or beyond the conflicting position.
      const conflict = entries.findIndex(previous => previous.seq >= sequence)
      entries.splice(conflict)
      break
    }

    entries.push(entry)
    previousSequence = sequence
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
      othrysHome(),
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

type OwnerEntries = ReturnType<typeof readLogEntries>

function keepValidPrefix({ log }: { log: OwnerEntries }): void {
  for (const [
    index,
    entry,
  ] of log.entries.entries()) {
    if (entry.seq !== index + 1 || log.entries[index + 1]?.seq === entry.seq) {
      log.corrupt = true
      log.entries.length = index

      return
    }
  }
}

export function readOwnerLogs(): Map<string, OwnerEntries> {
  const logs = new Map<string, OwnerEntries>()
  const entries = ownerLogPoleis().flatMap(polis => {
    const log = readLogEntries({ polis })
    logs.set(
      polis,
      log,
    )

    return log.entries
  })
  const moveCounterparts = new Map<OwnerEntry, OwnerEntry>()

  for (const source of entries) {
    const move = source.polisMove

    if (!move) {
      continue
    }

    let destination = logs.get(move.polis)

    if (!destination) {
      destination = {
        entries: [],
        corrupt: false,
      }
      logs.set(
        move.polis,
        destination,
      )
    }

    destination.entries.push(move.entry)
    moveCounterparts.set(
      move.entry,
      source,
    )
    moveCounterparts.set(
      source,
      move.entry,
    )
  }

  for (const log of logs.values()) {
    log.entries.sort((
      left,
      right,
    ) => left.seq - right.seq)
    keepValidPrefix({ log })
  }

  // Both sides of a move must survive replay. Truncating one log can invalidate a later move in another.
  let removed = true

  while (removed) {
    removed = false
    const valid = new Set([...logs.values()].flatMap(log => log.entries))

    for (const log of logs.values()) {
      const rejected = log.entries.findIndex(entry => {
        const counterpart = moveCounterparts.get(entry)

        return counterpart !== undefined && !valid.has(counterpart)
      })

      if (rejected === -1) {
        continue
      }

      log.entries.length = rejected
      log.corrupt = true
      removed = true
    }
  }

  return logs
}

export function ownerProjectMoves({ id }: { id: string }) {
  return [...readOwnerLogs().values()].flatMap(log => {
    if (log.corrupt) {
      throw new TitanError({
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

export function readOwnerEntries({
  polis = 'shared',
  logs = readOwnerLogs(),
}: {
  polis?: string
  logs?: Map<string, OwnerEntries>
} = {}) {
  return logs.get(polis) ?? {
    entries: [],
    corrupt: false,
  }
}
