// Reads a Firstmate task status log (`state/<task>.status`): append-only lines
// shaped `<verb> [key=<slug>] [at=<epoch>]: <note>`. Pure, so the same log always
// folds to the same open decisions. Follows Firstmate's own keyed-decision fold
// (bin/fm-classify-lib.sh): needs-decision and blocked open a key, resolved and
// captain-held close it, a ship or scout terminal line closes every key, and a
// line without a key uses the key "default".

export interface StatusLine {
  verb: string
  note: string
  // null when the line states a malformed key; such a line moves no decision.
  key: string | null
  // False for continuation prose: no colon and no key token.
  declares: boolean
  colon: boolean
}

// A status line kept as a card note: the decision asked or answered, or the report
// of finished work. line is the raw line, which names the note.
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

// Drops the worker-written `[at=...]` stamp runs that sit before the first colon,
// so a readable time like [at=10:30] cannot move the head/note boundary.
function unstamped({ line } : { line: string }): string {
  let keep = ''
  let rest = line

  for (;;) {
    const tag = rest.indexOf('[at=')

    if (tag < 0 || rest.indexOf(']', tag) < 0) {
      break
    }

    const before = rest.slice(0, tag)

    if (before.includes(':')) {
      break
    }

    keep += before.trimEnd()
    rest = rest.slice(rest.indexOf(']', tag) + 1)
  }

  return keep + rest
}

function verbOf({ head } : { head: string }): string {
  const words = head.split('[')[0]!.trim()

  if (!words.includes('corr=')) {
    return words
  }

  const [first, ...others] = words.split(/\s+/)

  return [first, ...others.filter(w => !CORR.test(w))].join(' ')
}

function noteHeadKey({ note } : { note: string }): string | undefined {
  return /^\[key=([^\]]*)\]/.exec(note)?.[1]
}

export function parseStatusLine({ line } : { line: string }): StatusLine {
  const text = unstamped({ line })
  const colon = text.includes(':')
  const head = colon ? text.slice(0, text.indexOf(':')) : text
  let note = colon ? text.slice(text.indexOf(':') + 1).trimStart() : text
  const before = /\[key=([^\]]*)\]/.exec(head)?.[1]
  let key: string | null = before ?? 'default'

  if (before === undefined && colon) {
    const atHead = noteHeadKey({ note })

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

  return { verb: verbOf({ head }), note, key, declares: colon || /\[key=.*\]/.test(text), colon }
}

function transitionAllowed({ key, note } : { key: string; note: string }): boolean {
  const prefix = RESERVED_PREFIXES.find(p => key.startsWith(p))

  return prefix === undefined || (note.startsWith(prefix) && note.includes(':'))
}

// The decisions still open after the whole log, oldest-opened first. kind is the
// task's meta kind; only ship and scout terminal lines close every decision.
export function openDecisions({ log, kind } : { log: string; kind: string }): OpenDecision[] {
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
      open.set(line.key, { verb: line.verb, key: line.key, note: line.note })
    }
  }

  return [...open.values()]
}

// The latest line with a verb and a colon.
export function latestLine({ log } : { log: string }): StatusLine | undefined {
  const lines = log.split('\n')

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = parseStatusLine({ line: lines[i]! })

    if (line.colon && line.verb) {
      return line
    }
  }

  return undefined
}

// The latest declared line as `<verb>: <note>`, for the card's activity.
export function latestActivity({ log } : { log: string }): string | undefined {
  const line = latestLine({ log })

  return line && (line.note ? `${line.verb}: ${line.note}` : line.verb)
}

const NOTE_VERBS: Record<string, StatusNote['kind']> = { 'needs-decision': 'decision', resolved: 'decision', done: 'summary' }

// needs-decision, resolved and done lines with their text, oldest first. A
// numeric [at=<epoch>] stamp gives the note its time.
export function statusNotes({ log } : { log: string }): StatusNote[] {
  const notes: StatusNote[] = []

  for (const raw of log.split('\n')) {
    const line = parseStatusLine({ line: raw })
    const kind = NOTE_VERBS[line.verb]

    // A malformed key moves nothing in Firstmate's fold, so it records nothing here.
    if (!kind || !line.colon || line.key === null || !line.note.trim()) {
      continue
    }

    const key = line.key && line.key !== 'default' ? ` [${line.key}]` : ''
    const epoch = /\[at=(\d+)\]/.exec(raw)?.[1]
    notes.push({ kind, text: `${line.verb}${key}: ${line.note.trim()}`, line: raw, ...(epoch ? { at: new Date(Number(epoch) * 1000).toISOString() } : {}) })
  }

  return notes
}
