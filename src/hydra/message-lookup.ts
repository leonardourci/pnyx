import type { HydraEvent } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import { countTokens } from '#workers/token-count.ts'
import { HYDRA_CARD } from './identity.ts'
import { HISTORY_BUDGET } from './history.ts'
import { messageRecords, type MessageRecord } from './message-records.ts'
import type { SessionEntry } from './transcripts-read.ts'

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

interface Cursor {
  hydra: string
  card: string
  snapshot: number
  start: number
  end: number
  position: number
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
  return `m1:${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
}

function decodeCursor({ value }: { value: string }): Cursor {
  let cursor: Cursor

  try {
    if (value.length > MAX_CURSOR_LENGTH || !/^m1:[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error('format')
    }

    cursor = JSON.parse(Buffer.from(
      value.slice(3),
      'base64url',
    ).toString('utf8')) as Cursor
  } catch {
    invalid({ message: 'Invalid message cursor; copy an older or newer cursor from a lookup result' })
  }

  if (!cursor || typeof cursor !== 'object' || typeof cursor.hydra !== 'string' || typeof cursor.card !== 'string'
    || ![
      cursor.snapshot,
      cursor.start,
      cursor.end,
      cursor.position,
    ].every(value => Number.isSafeInteger(value) && value >= 0)
    || cursor.start > cursor.position || cursor.position > cursor.end
    || (cursor.from !== undefined && typeof cursor.from !== 'string')
    || (cursor.to !== undefined && typeof cursor.to !== 'string')
    || (cursor.direction !== 'older' && cursor.direction !== 'newer')) {
    invalid({ message: 'Invalid message cursor bounds' })
  }

  return cursor
}

export function lookupMessages({
  hydraId,
  card = HYDRA_CARD,
  events,
  entries,
  snapshot,
  selection = {},
}: {
  hydraId: string
  card?: string
  events: HydraEvent[]
  // The thread's native transcript entries, with their references.
  entries: SessionEntry[]
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

  const messages = messageRecords({
    events,
    entries,
    card,
  }).filter(message => {
    if (message.seq > snapshot) {
      return false
    }

    const time = Date.parse(message.at)

    return message.sequences.some(seq => {
      const lowerValue = lower?.kind === 'seq' ? seq : time
      const upperValue = upper?.kind === 'seq' ? seq : time

      return (!lower || lowerValue >= lower.value) && (!upper || upperValue <= upper.value)
    })
  })
  const start = cursor?.start ?? 0
  const end = cursor?.end ?? messages.length
  let position = cursor?.position ?? start
  const direction = cursor?.direction ?? selection.direction ?? 'newer'

  if (end > messages.length) {
    invalid({ message: 'This message cursor is outside the recorded snapshot' })
  }

  let anchor: number | undefined

  if (selectors.length) {
    const time = selection.at === undefined ? undefined : timestamp({ value: selection.at })
    const matches = messages.map((
      message,
      index,
    ) => ({
      message,
      index,
    })).filter(({ message }) => {
      if (selection.id !== undefined) {
        return message.id === selection.id || message.aliases.includes(selection.id)
      }

      if (selection.seq !== undefined) {
        return message.sequences.includes(selection.seq)
      }

      return Date.parse(message.at) === time
    })

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
        ).map(({ message }) => `${message.id} (seq ${message.seq})`)
          .join(', ')}`,
      })
    }

    anchor = matches[0].index
    position = direction === 'older' ? anchor : anchor + 1
  } else if (!cursor) {
    position = direction === 'older' ? end : start
  }

  const page: MessageRecord[] = []

  const add = ({
    index,
    prepend = false,
  }: {
    index: number
    prepend?: boolean
  }) => {
    const candidate = messages[index]
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

  let first = position
  let last = position

  if (anchor !== undefined && selection.direction === undefined) {
    add({ index: anchor })
    first = anchor
    last = anchor + 1
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
      const older = anchor - distance
      const newer = anchor + distance
      const takeOlder = olderOpen && distance <= before && older >= start
      const takeNewer = newerOpen && distance <= after && newer < end

      if (!takeOlder && !takeNewer) {
        break
      }

      if (takeOlder) {
        olderOpen = add({
          index: older,
          prepend: true,
        })

        if (olderOpen) {
          first = older
        }
      }

      if (takeNewer) {
        newerOpen = add({ index: newer })

        if (newerOpen) {
          last = newer + 1
        }
      }
    }
  } else if (direction === 'older') {
    for (let index = position - 1; index >= start; index--) {
      if (!add({
        index,
        prepend: true,
      })) {
        break
      }

      first = index
    }
  } else {
    for (let index = position; index < end; index++) {
      if (!add({ index })) {
        break
      }

      last = index + 1
    }
  }

  const continuation = ({
    position,
    direction,
  }: {
    position: number
    direction: Cursor['direction']
  }) =>
    encodeCursor({
      cursor: {
        hydra: hydraId,
        card,
        snapshot,
        start,
        end,
        position,
        direction,
        from,
        to,
      },
    })

  return {
    hydra: hydraId,
    thread: card === HYDRA_CARD ? 'hydra' : card,
    snapshot,
    anchor: anchor === undefined ? undefined : messages[anchor].id,
    messages: page.map(message => outputMessage({ message })),
    tokens: countTokens({ text: page.map(message => message.text).join('\n\n') }),
    budget,
    limit,
    older: first > start ? continuation({
      position: first,
      direction: 'older',
    }) : undefined,
    newer: last < end ? continuation({
      position: last,
      direction: 'newer',
    }) : undefined,
    note: page.length ? 'Whole messages in chronological order. Cursors keep this thread, range and snapshot.' : 'No messages in this selection.',
  }
}
