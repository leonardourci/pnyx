export interface StatusLine {
  verb: string
  note: string
  // null when the line states a malformed key; such a line moves no decision.
  key: string | null
  // False for continuation prose: no colon and no key token.
  declares: boolean
  colon: boolean
}

// The raw line is the stable identity of a status note.
export interface StatusNote {
  kind: 'decision' | 'summary'
  text: string
  at?: string
  line: string
}

export interface OpenDecision {
  verb: string
  key: string
  note: string
}

const SLUG = /^[A-Za-z0-9._-]+$/
const CORR = /^corr=[0-9A-Fa-f]{16}$/
// A reserved key may only be opened or closed by a note in its owner's vocabulary.
const RESERVED_PREFIXES = ['pending-reply-']

function verbOf({ head }: { head: string }): string {
  const words = head.split('[')[0]!.trim()

  if (!words.includes('corr=')) {
    return words
  }

  const [
    first,
    ...others
  ] = words.split(/\s+/)

  return [
    first,
    ...others.filter(w => !CORR.test(w)),
  ].join(' ')
}

export function parseStatusLine({ line }: { line: string }): StatusLine {
  // A complete header timestamp may contain colons; timestamps in the note stay literal.
  const separator = [...line.matchAll(/\[at=[^\]]*\]|:/g)].find(token => token[0] === ':')?.index ?? -1
  const colon = separator >= 0
  const head = (colon ? line.slice(
    0,
    separator,
  ) : line).replace(
    /\s*\[at=[^\]]*\]/g,
    '',
  )
  let note = colon ? line.slice(separator + 1).trimStart() : head
  const before = /\[key=([^\]]*)\]/.exec(head)?.[1]
  let key: string | null = before ?? 'default'

  if (before === undefined && colon) {
    const atHead = /^\[key=([^\]]*)\]/.exec(note)?.[1]

    if (atHead !== undefined) {
      key = atHead

      if (SLUG.test(atHead)) {
        note = note.slice(`[key=${atHead}]`.length).trimStart()
      }
    }
  }

  if (key !== null && !SLUG.test(key)) {
    key = null
  }

  return {
    verb: verbOf({ head }),
    note,
    key,
    declares: colon || /\[key=.*\]/.test(head),
    colon,
  }
}

function transitionAllowed({
  key,
  note,
}: {
  key: string
  note: string
}): boolean {
  const prefix = RESERVED_PREFIXES.find(p => key.startsWith(p))

  return prefix === undefined || (note.startsWith(prefix) && note.includes(':'))
}

// Only ship and scout terminal lines close every decision.
export function openDecisions({
  log,
  kind,
}: {
  log: string
  kind: string
}): OpenDecision[] {
  const open = new Map<string, OpenDecision>()

  for (const raw of log.split('\n')) {
    const line = parseStatusLine({ line: raw })

    if (!line.declares) {
      continue
    }

    if (line.colon && (line.verb === 'done' || line.verb === 'failed') && (kind === 'ship' || kind === 'scout')) {
      open.clear()
      continue
    }

    const opens = line.verb === 'needs-decision' || line.verb === 'blocked'
    const closes = line.verb === 'resolved' || line.verb === 'captain-held'

    if ((!opens && !closes) || line.key === null || !transitionAllowed({
      key: line.key,
      note: line.note,
    })) {
      continue
    }

    open.delete(line.key)

    if (opens) {
      open.set(
        line.key,
        {
          verb: line.verb,
          key: line.key,
          note: line.note,
        },
      )
    }
  }

  return [...open.values()]
}

export function latestLine({ log }: { log: string }): StatusLine | undefined {
  const lines = log.split('\n')

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = parseStatusLine({ line: lines[i]! })

    if (line.colon && line.verb) {
      return line
    }
  }

  return undefined
}

export function latestActivity({ log }: { log: string }): string | undefined {
  const line = latestLine({ log })

  return line && (line.note ? `${line.verb}: ${line.note}` : line.verb)
}

const NOTE_VERBS: Record<string, StatusNote['kind']> = {
  'needs-decision': 'decision',
  resolved: 'decision',
  done: 'summary',
}

// Only numeric epoch stamps supply a note timestamp.
export function statusNotes({ log }: { log: string }): StatusNote[] {
  const notes: StatusNote[] = []

  for (const raw of log.split('\n')) {
    const line = parseStatusLine({ line: raw })
    const kind = NOTE_VERBS[line.verb]

    // Malformed keys cannot change decisions or produce notes.
    if (!kind || !line.colon || line.key === null || !line.note.trim()) {
      continue
    }

    const key = line.key && line.key !== 'default' ? ` [${line.key}]` : ''
    const epoch = /\[at=(\d+)\]/.exec(raw)?.[1]
    notes.push({
      kind,
      text: `${line.verb}${key}: ${line.note.trim()}`,
      line: raw,
      ...(epoch ? { at: new Date(Number(epoch) * 1000).toISOString() } : {}),
    })
  }

  return notes
}
