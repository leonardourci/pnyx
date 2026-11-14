import { HydraError } from '#store/errors.ts'
import { countTokens } from '#workers/token-count.ts'
import { HYDRA_CARD } from './identity.ts'
import { HISTORY_BUDGET } from './history.ts'
import { compareMessages, type MessageRecord } from './message-records.ts'

const MAX_CURSOR_LENGTH = 4096
export const MESSAGE_PAGE_BYTES = 20000
export const MESSAGE_PAGE_LIMIT = 60
const DEFAULT_LIMIT = 20
const TIMESTAMP_ERROR = 'Use an ISO timestamp with a timezone, as shown in the comment or the "at" field of the message'
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

export interface MessageSelection {
  id?: string
  seq?: number
  at?: string
  before?: number
  after?: number
  direction?: string
  from?: string
  to?: string
  cursor?: string
  budget?: number
  limit?: number
}

interface Key {
  seq: number
  at: string
  id: string
}

interface Cursor {
  hydra: string
  card: string
  snapshot: number
  // The message the page stopped at, which the next page leaves out.
  key: Key
  direction: 'older' | 'newer'
  from?: string
  to?: string
}

function invalid({ message }: { message: string }): never {
  throw new HydraError({
    code: 'VALIDATION_ERROR',
    message,
  })
}

function timestamp({ value }: { value: string }): number {
  // An offset makes the same command independent of the receiving agent's timezone.
  const match = ISO_TIMESTAMP.exec(value)

  if (!match) {
    invalid({ message: TIMESTAMP_ERROR })
  }

  const calendar = new Date(`${match[1]}T00:00:00Z`)
  const validCalendar = Number.isFinite(calendar.getTime())
    && calendar.toISOString().startsWith(match[1])
  const time = Date.parse(value)

  if (!validCalendar || !Number.isFinite(time)) {
    invalid({ message: TIMESTAMP_ERROR })
  }

  return time
}

const outputMessage = ({ message }: { message: MessageRecord }) => ({
  id: message.id,
  seq: message.seq,
  at: message.at,
  role: message.role,
  text: message.text,
})

function fits({
  messages,
  budget,
}: {
  messages: MessageRecord[]
  budget: number
}): boolean {
  const output = messages.map(message => outputMessage({ message }))

  return countTokens({ text: output.map(message => message.text).join('\n\n') }) <= budget
    && Buffer.byteLength(JSON.stringify(output)) <= MESSAGE_PAGE_BYTES
}

function encodeCursor({ cursor }: { cursor: Cursor }): string {
  return `m2:${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
}

function decodeCursor({ value }: { value: string }): Cursor {
  let cursor: Cursor

  try {
    if (value.length > MAX_CURSOR_LENGTH || !/^m2:[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error('format')
    }

    cursor = JSON.parse(Buffer.from(
      value.slice(3),
      'base64url',
    ).toString('utf8')) as Cursor
  } catch {
    invalid({ message: 'Invalid message cursor; copy an older or newer cursor from a lookup result' })
  }

  const key = cursor?.key as Partial<Key> | undefined

  if (!cursor || typeof cursor !== 'object' || typeof cursor.hydra !== 'string' || typeof cursor.card !== 'string'
    || !Number.isSafeInteger(cursor.snapshot) || cursor.snapshot < 0
    || !key || typeof key !== 'object' || !Number.isSafeInteger(key.seq) || typeof key.at !== 'string'
    || typeof key.id !== 'string'
    || (cursor.from !== undefined && typeof cursor.from !== 'string')
    || (cursor.to !== undefined && typeof cursor.to !== 'string')
    || (cursor.direction !== 'older' && cursor.direction !== 'newer')) {
    invalid({ message: 'Invalid message cursor bounds' })
  }

  return cursor
}

// A thread's recorded messages, read a window of the log at a time.
export interface LookupThread {
  // The messages recorded at log positions after lo, up to and including hi.
  window({
    lo,
    hi,
  }: {
    lo: number
    hi: number
  }): MessageRecord[]
  // The log position of the message a reference names, when it names one.
  locate({ id }: { id: string }): number | undefined
  // The first and last log positions whose messages can have been recorded at a time.
  around({ time }: { time: number }): {
    first: number
    last: number
  }
}

// How many log positions one read covers, so a statement never runs long however large the thread.
export const LOOKUP_WINDOW = 4000

const keyOf = ({ message }: { message: MessageRecord }): Key => ({
  seq: message.seq,
  at: message.at,
  id: message.id,
})

// The messages beyond a key in one direction, a window at a time, nearest first.
function* walk({
  thread,
  direction,
  beyond,
  min,
  max,
  accept,
}: {
  thread: LookupThread
  direction: 'older' | 'newer'
  beyond?: Key
  min: number
  max: number
  accept: ({ message }: { message: MessageRecord }) => boolean
}): Generator<MessageRecord> {
  const sign = direction === 'newer' ? 1 : -1
  const after = ({ message }: { message: MessageRecord }) => !beyond || sign * compareMessages({
    a: message,
    b: beyond,
  }) > 0
  const passed = ({ message }: { message: MessageRecord }) => accept({ message })
    && after({ message })

  if (direction === 'newer') {
    for (let lo = Math.max(
      min,
      beyond?.seq ?? min,
    ) - 1; lo < max; lo += LOOKUP_WINDOW) {
      yield* thread.window({
        lo,
        hi: Math.min(
          lo + LOOKUP_WINDOW,
          max,
        ),
      }).filter(message => passed({ message }))
    }

    return
  }

  for (let hi = Math.min(
    max,
    beyond?.seq ?? max,
  ); hi >= min;) {
    const lo = Math.max(
      hi - LOOKUP_WINDOW,
      min - 1,
    )
    yield* thread.window({
      lo,
      hi,
    }).filter(message => passed({ message }))
      .reverse()
    hi = lo
  }
}

// A walk that can be looked at before it is taken from.
function lookahead({ messages }: { messages: Generator<MessageRecord> }) {
  let head = messages.next()

  return {
    peek: () => head.done ? undefined : head.value,
    take: () => {
      head = messages.next()
    },
  }
}

export function lookupMessages({
  thread,
  hydraId,
  card = HYDRA_CARD,
  snapshot,
  selection = {},
}: {
  thread: LookupThread
  hydraId: string
  card?: string
  snapshot: number
  selection?: MessageSelection
}) {
  const budget = Math.min(
    selection.budget ?? HISTORY_BUDGET,
    HISTORY_BUDGET,
  )
  const limit = Math.min(
    selection.limit ?? DEFAULT_LIMIT,
    MESSAGE_PAGE_LIMIT,
  )
  const counts = [
    selection.budget ?? HISTORY_BUDGET,
    selection.limit ?? DEFAULT_LIMIT,
    selection.before ?? 0,
    selection.after ?? 0,
  ]

  const invalidSequence = selection.seq !== undefined
    && (!Number.isSafeInteger(selection.seq) || selection.seq < 1)

  if (invalidSequence) {
    invalid({ message: '--seq must be a positive safe integer' })
  }

  const validCounts = counts.every(value => Number.isSafeInteger(value) && value >= 0)

  if (!validCounts || budget === 0 || limit === 0) {
    invalid({
      message: '--budget/--limit must be positive; --before/--after must be nonnegative integers',
    })
  }

  const selectors = [
    selection.id,
    selection.seq,
    selection.at,
  ].filter(value => value !== undefined)
  const surrounding = selection.before !== undefined || selection.after !== undefined
  const ranged = selection.from !== undefined || selection.to !== undefined

  const conflictingSelection = selectors.length > 1 || (ranged && selectors.length)
    || (surrounding && !selectors.length)

  if (conflictingSelection) {
    invalid({ message: 'Choose one of --id, --seq or --at for surroundings, or use --from/--to for a range' })
  }

  if (selection.direction !== undefined && selection.direction !== 'older' && selection.direction !== 'newer') {
    invalid({ message: '--direction must be older or newer' })
  }

  if (surrounding && selection.direction !== undefined) {
    invalid({ message: 'Use surroundings or --direction; direction pages exclude the selected message' })
  }

  const cursorSelection = selectors.length || ranged || surrounding
    || selection.direction !== undefined

  if (selection.cursor && cursorSelection) {
    invalid({
      message: 'Use --cursor alone or with --budget and --limit to continue the saved selection',
    })
  }

  const cursor = selection.cursor ? decodeCursor({ value: selection.cursor }) : undefined

  if (cursor && (cursor.hydra !== hydraId || cursor.card !== card || cursor.snapshot > snapshot)) {
    invalid({ message: 'This cursor belongs to another Hydra, thread or unavailable snapshot' })
  }

  snapshot = cursor?.snapshot ?? snapshot
  const from = cursor?.from ?? selection.from
  const to = cursor?.to ?? selection.to

  const rangeValue = ({ value }: { value: string }) => {
    if (!/^\d+$/.test(value)) {
      return {
        kind: 'time',
        value: timestamp({ value }),
      }
    }

    const seq = Number(value)

    if (!Number.isSafeInteger(seq)) {
      invalid({ message: 'Range sequences must be safe integers' })
    }

    return {
      kind: 'seq',
      value: seq,
    }
  }

  const lower = from === undefined ? undefined : rangeValue({ value: from })
  const upper = to === undefined ? undefined : rangeValue({ value: to })

  if (lower && upper && lower.kind === upper.kind && lower.value > upper.value) {
    invalid({ message: '--from must precede --to' })
  }

  const seqBound = ({
    bound,
    side,
  }: {
    bound: typeof lower
    side: 'first' | 'last'
  }) => {
    if (!bound) {
      return side === 'first' ? 1 : snapshot
    }

    if (bound.kind === 'seq') {
      return bound.value
    }

    const found = thread.around({ time: bound.value })

    // A transcript message can sit one position after the last event recorded before it.
    return side === 'first' ? found.first : found.last + 1
  }

  const min = Math.max(
    1,
    seqBound({
      bound: lower,
      side: 'first',
    }),
  )
  const max = Math.min(
    snapshot,
    seqBound({
      bound: upper,
      side: 'last',
    }),
  )

  const accept = ({ message }: { message: MessageRecord }) => {
    if (message.seq > snapshot) {
      return false
    }

    const time = Date.parse(message.at)

    return message.sequences.some(seq => {
      const lowerValue = lower?.kind === 'seq' ? seq : time
      const upperValue = upper?.kind === 'seq' ? seq : time

      return (!lower || lowerValue >= lower.value) && (!upper || upperValue <= upper.value)
    })
  }

  const direction = cursor?.direction ?? selection.direction ?? 'newer'

  let anchor: MessageRecord | undefined

  if (selectors.length) {
    const time = selection.at === undefined ? undefined : timestamp({ value: selection.at })
    let candidates: MessageRecord[] = []

    if (selection.id !== undefined) {
      const seq = thread.locate({ id: selection.id })
      candidates = seq === undefined ? [] : thread.window({
        lo: seq - 1,
        hi: seq,
      }).filter(message => message.id === selection.id || message.aliases.includes(selection.id!))
    } else if (selection.seq !== undefined) {
      candidates = selection.seq > snapshot ? [] : thread.window({
        lo: selection.seq - 1,
        hi: selection.seq,
      }).filter(message => message.sequences.includes(selection.seq!))
    } else {
      const found = thread.around({ time: time! })

      for (let lo = found.first - 1; lo < Math.min(
        found.last + 1,
        snapshot,
      ); lo += LOOKUP_WINDOW) {
        candidates.push(...thread.window({
          lo,
          hi: Math.min(
            lo + LOOKUP_WINDOW,
            found.last + 1,
            snapshot,
          ),
        }).filter(message => Date.parse(message.at) === time))
      }
    }

    const matches = candidates.filter(message => accept({ message }))

    if (!matches.length) {
      throw new HydraError({
        code: 'NOT_FOUND',
        message: 'No recorded message matches that reference in this thread',
      })
    }

    if (matches.length > 1) {
      throw new HydraError({
        code: 'CONFLICT',
        message: `Several messages match; use --id: ${matches.slice(
          0,
          MESSAGE_PAGE_LIMIT,
        ).map(message => `${message.id} (seq ${message.seq})`)
          .join(', ')}`,
      })
    }

    anchor = matches[0]
  }

  const messagesBeyond = ({
    side,
    beyond,
  }: {
    side: 'older' | 'newer'
    beyond?: Key
  }) => lookahead({
    messages: walk({
      thread,
      direction: side,
      beyond,
      min,
      max,
      accept,
    }),
  })

  const page: MessageRecord[] = []

  const add = ({
    candidate,
    prepend = false,
  }: {
    candidate: MessageRecord
    prepend?: boolean
  }) => {
    const next = prepend ? [
      candidate,
      ...page,
    ] : [
      ...page,
      candidate,
    ]

    if (next.length > limit || !fits({
      messages: next,
      budget,
    })) {
      if (!page.length) {
        throw new HydraError({
          code: 'MESSAGE_TOO_LARGE',
          message: `Message ${candidate.id} (seq ${candidate.seq}) exceeds this page's budget or ${MESSAGE_PAGE_BYTES} byte limit; raise --budget up to ${HISTORY_BUDGET} or select a different message`,
        })
      }

      return false
    }

    page.splice(
      0,
      page.length,
      ...next,
    )

    return true
  }

  if (anchor && selection.direction === undefined) {
    add({ candidate: anchor })
    const key = keyOf({ message: anchor })
    const older = messagesBeyond({
      side: 'older',
      beyond: key,
    })
    const newer = messagesBeyond({
      side: 'newer',
      beyond: key,
    })
    const before = selection.before ?? (selection.budget === undefined ? 0 : MESSAGE_PAGE_LIMIT)
    const after = selection.after ?? (selection.budget === undefined ? 0 : MESSAGE_PAGE_LIMIT)
    let olderOpen = true
    let newerOpen = true

    for (let distance = 1; distance <= Math.min(
      Math.max(
        before,
        after,
      ),
      MESSAGE_PAGE_LIMIT,
    ); distance++) {
      const nextOlder = olderOpen && distance <= before ? older.peek() : undefined
      const nextNewer = newerOpen && distance <= after ? newer.peek() : undefined

      if (!nextOlder && !nextNewer) {
        break
      }

      if (nextOlder) {
        olderOpen = add({
          candidate: nextOlder,
          prepend: true,
        })

        if (olderOpen) {
          older.take()
        }
      }

      if (nextNewer) {
        newerOpen = add({ candidate: nextNewer })

        if (newerOpen) {
          newer.take()
        }
      }
    }
  } else {
    const beyond = cursor?.key ?? (anchor && keyOf({ message: anchor }))
    const messages = messagesBeyond({
      side: direction,
      beyond,
    })

    let next = messages.peek()

    while (next && add({
      candidate: next,
      prepend: direction === 'older',
    })) {
      messages.take()
      next = messages.peek()
    }
  }

  const continuation = ({
    message,
    direction,
  }: {
    message: MessageRecord
    direction: Cursor['direction']
  }) =>
    messagesBeyond({
      side: direction,
      beyond: keyOf({ message }),
    }).peek() ? encodeCursor({
        cursor: {
          hydra: hydraId,
          card,
          snapshot,
          key: keyOf({ message }),
          direction,
          from,
          to,
        },
      }) : undefined

  return {
    hydra: hydraId,
    thread: card === HYDRA_CARD ? 'hydra' : card,
    snapshot,
    anchor: anchor?.id,
    messages: page.map(message => outputMessage({ message })),
    tokens: countTokens({ text: page.map(message => message.text).join('\n\n') }),
    budget,
    limit,
    older: page.length ? continuation({
      message: page[0],
      direction: 'older',
    }) : undefined,
    newer: page.length ? continuation({
      message: page.at(-1)!,
      direction: 'newer',
    }) : undefined,
    note: page.length ? 'Whole messages in chronological order. Cursors keep this thread, range and snapshot.' : 'No messages in this selection.',
  }
}
