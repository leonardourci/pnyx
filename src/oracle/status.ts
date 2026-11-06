import { existsSync, statSync } from 'node:fs'
import { EVENTS, isCurrent, openReader, searchPath, type Cursor } from './index.ts'
import type { IndexStatus, Kind } from './model.ts'

// Reads the index without writing it. Null when it has not been built.
export function indexStatus({ hydraId }: { hydraId: string }): IndexStatus | null {
  const path = searchPath({ hydraId })

  if (!existsSync(path)) {
    return null
  }

  const db = openReader({ path })

  try {
    const bytes = statSync(path).size

    if (!isCurrent({ db })) {
      return {
        builtThrough: 0,
        docs: {
          event: 0,
          note: 0,
          transcript: 0,
        },
        transcripts: {
          tracked: 0,
          missing: 0,
        },
        bytes,
        current: false,
      }
    }

    const count = ({ kind }: { kind: Kind }) => (db.prepare('SELECT count(*) AS n FROM docs WHERE kind = ?').get(kind) as { n: number }).n
    const cursors = db.prepare('SELECT * FROM cursors').all() as unknown as Cursor[]
    const transcripts = cursors.filter(c => c.source !== EVENTS)

    return {
      builtThrough: cursors.find(c => c.source === EVENTS)?.seq ?? 0,
      docs: {
        event: count({ kind: 'event' }),
        note: count({ kind: 'note' }),
        transcript: count({ kind: 'transcript' }),
      },
      transcripts: {
        tracked: transcripts.length,
        missing: transcripts.filter(c => !existsSync(c.source)).length,
      },
      bytes,
      current: true,
    }
  } finally {
    db.close()
  }
}

// The last event seq indexed, without indexStatus's full counts; null when missing or from another version.
export function indexedThrough({ hydraId }: { hydraId: string }): number | null {
  const path = searchPath({ hydraId })

  if (!existsSync(path)) {
    return null
  }

  const db = openReader({ path })

  try {
    if (!isCurrent({ db })) {
      return null
    }

    const events = db.prepare('SELECT seq FROM cursors WHERE source = ?').get(EVENTS) as { seq: number } | undefined

    // A first build commits its tables before its events.
    if (!events) {
      return 0
    }

    return events.seq
  } finally {
    db.close()
  }
}
