import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { privateDir, writeDurably } from './storage.ts'

const cache = new Map<string, {
  key: string
  entries: unknown[]
}>()

// Each complete line's entry, the same array until the file changes; a torn last line was never saved.
export function readJournal<T>({
  path,
  readable,
}: {
  path: string
  readable({ entry }: { entry: T }): boolean
}): T[] {
  const stat = statSync(
    path,
    { throwIfNoEntry: false },
  )
  const key = `${stat?.size ?? -1}:${stat?.mtimeMs ?? 0}`
  const cached = cache.get(path)

  if (cached?.key === key) {
    return cached.entries as T[]
  }

  const text = stat ? readFileSync(
    path,
    'utf8',
  ) : ''
  const lines = text.split('\n').slice(
    0,
    -1,
  )
    .filter(Boolean)
  const entries = lines.flatMap(line => {
    try {
      const entry = JSON.parse(line) as T

      return readable({ entry }) ? [entry] : []
    } catch {
      return []
    }
  })
  const skipped = lines.length - entries.length

  if (skipped) {
    console.error(`pnyx-axi: skipped ${skipped} unreadable lines in ${path}`)
  }

  cache.set(
    path,
    {
      key,
      entries,
    },
  )

  return entries
}

// Appends one entry as a durable line, or creates an empty journal when there is none.
export function appendJournal({
  path,
  entry,
}: {
  path: string
  entry?: unknown
}): void {
  privateDir({ dir: dirname(path) })
  // A torn last line keeps its own line, so the new entry is never glued onto it.
  const torn = existsSync(path) && statSync(path).size > 0 && !readFileSync(
    path,
    'utf8',
  ).endsWith('\n')
  const line = entry === undefined ? '' : `${JSON.stringify(entry)}\n`
  writeDurably({
    path,
    data: `${torn ? '\n' : ''}${line}`,
    flag: 'a',
  })
}
