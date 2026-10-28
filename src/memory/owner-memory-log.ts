import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LearningChange } from './learnings.ts'
import type { ProjectMemoryEvent } from './project-memory.ts'
import { pnyxHome } from '../store/paths.ts'

// One replacement or removal of an owner memory key; the log is only appended, so every old version stays.
export interface OwnerEntry {
  v: 1
  seq: number
  at: string
  actor: string
  reason?: string
  confirmed?: string
  learning?: LearningChange
  key: string
  before: string | null
  after: string | null
  // Both changes commit here; project replay includes this event in its sequence.
  projectMove?: {
    project: string
    event: ProjectMemoryEvent
  }
}

export const ownerMemoryLogPath = () => join(
  pnyxHome(),
  'owner',
  'memory.jsonl',
)

export function readOwnerEntries(): {
  entries: OwnerEntry[]
  corrupt: boolean
} {
  let text = ''

  try {
    text = readFileSync(
      ownerMemoryLogPath(),
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

    entries.push(entry)
  }

  return {
    entries,
    corrupt,
  }
}
