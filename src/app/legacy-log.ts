import type { Transaction } from './transactions.ts'
import { asRecord } from './command-validation.ts'
import { EVENT_TYPES, type HydraEvent } from './model.ts'
import { EVENT_VERSION } from '#store/events.ts'
import { HydraError } from '#store/errors.ts'
import { logPath } from '#store/storage.ts'
import { existsSync, readFileSync } from 'node:fs'

export interface LogRead {
  events: HydraEvent[]
  transactions: Transaction[]
  // The complete file's size, retained to detect an older writer appending after import.
  bytes: number
}

// Appended by an older Pnyx's repair command after it closed a torn line with a newline. Readers skip the
// line it names; it is not a Hydra event and takes no sequence number.
export interface RepairMarker {
  v: typeof EVENT_VERSION
  type: 'log.repaired'
  at: string
  data: {
    offset: number
    length: number
  }
}

function parseLine({ line }: { line: string }): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function repairMarker({ value }: { value: unknown }): RepairMarker | undefined {
  const m = value as Partial<RepairMarker> | undefined

  return m?.type === 'log.repaired' && Number.isInteger(m.data?.offset) && Number.isInteger(m.data?.length)
    ? m as RepairMarker
    : undefined
}

function corrupt({ offset }: { offset: number }): HydraError {
  return new HydraError({
    message: `events.jsonl is corrupt at byte ${offset}`,
    code: 'LOG_CORRUPT',
    help: ['The log is never rewritten automatically; inspect that line by hand'],
  })
}

function toEvent({
  event,
  offset,
}: {
  event: unknown
  offset: number
}): HydraEvent {
  const e = event as Partial<HydraEvent> | undefined

  if (
    typeof e !== 'object' ||
    e === null ||
    !Number.isInteger(e.seq) ||
    typeof e.id !== 'string' ||
    typeof e.cardId !== 'string' ||
    !EVENT_TYPES.includes(e.type as HydraEvent['type'])
  ) {
    throw corrupt({ offset })
  }

  if (e.v !== EVENT_VERSION) {
    throw new HydraError({
      message: `event at byte ${offset} has schema v${e.v}; this pnyx-axi reads v${EVENT_VERSION}`,
      code: 'UNSUPPORTED_VERSION',
    })
  }

  return e as HydraEvent
}

// A repaired line is skipped; an incomplete last line is refused so an import cannot lose its events.
export function readLog({ dir }: { dir: string }): LogRead {
  const path = logPath({ dir })

  if (!existsSync(path)) {
    return {
      events: [],
      transactions: [],
      bytes: 0,
    }
  }

  const buf = readFileSync(path)
  const complete = buf.lastIndexOf(10) + 1

  if (complete !== buf.length) {
    throw new HydraError({
      message: `events.jsonl has a torn tail of ${buf.length - complete} bytes at byte ${complete}`,
      code: 'TORN_TAIL',
      help: ['Keep a backup and repair the incomplete line before importing this Hydra'],
    })
  }

  const events: HydraEvent[] = []
  const transactions: Transaction[] = []
  let previous: {
    offset: number
    length: number
    count?: number
    transaction?: Transaction
    error?: HydraError
  } | undefined

  for (let start = 0; start < complete; ) {
    const end = buf.indexOf(
      10,
      start,
    )
    const offset = start
    const line = buf.toString(
      'utf8',
      start,
      end,
    )
    const length = end - start
    start = end + 1

    if (line.trim() === '') {
      continue
    }

    const value = parseLine({ line })

    const marker = repairMarker({ value })

    if (marker) {
      if (previous?.offset !== marker.data.offset || previous.length !== marker.data.length) {
        throw corrupt({ offset })
      }

      if (previous.count) {
        events.splice(events.length - previous.count)
      }

      if (previous.transaction) {
        transactions.pop()
      }

      previous = undefined
      continue
    }

    if (previous?.error) {
      throw previous.error
    }

    previous = {
      offset,
      length,
    }

    try {
      const record = asRecord({ value })

      if (record?.type === 'log.transaction') {
        if (record.v !== EVENT_VERSION || typeof record.id !== 'string'
          || typeof record.digest !== 'string' || !Array.isArray(record.events)
          || !asRecord({ value: record.receipt })) {
          throw corrupt({ offset })
        }

        const children = record.events.map(event => toEvent({
          event,
          offset,
        }))
        const receiptEvent = children.at(-1)

        if (receiptEvent?.type !== 'apply.recorded' || receiptEvent.id !== record.id
          || receiptEvent.data.digest !== record.digest) {
          throw corrupt({ offset })
        }

        if (children.some((
          event,
          index,
        ) => event.transaction !== record.id
          || (index > 0 && event.seq !== children[index - 1]!.seq + 1))) {
          throw corrupt({ offset })
        }

        const transaction: Transaction = {
          v: EVENT_VERSION,
          type: 'log.transaction',
          id: record.id,
          digest: record.digest,
          events: children,
          receipt: record.receipt as Record<string, unknown>,
        }
        transactions.push(transaction)
        events.push(...children)
        previous.count = children.length
        previous.transaction = transaction
      } else {
        events.push(toEvent({
          event: value,
          offset,
        }))
        previous.count = 1
      }
    } catch (error) {
      previous.error = error as HydraError
    }
  }

  if (previous?.error) {
    throw previous.error
  }

  return {
    events,
    transactions,
    bytes: buf.length,
  }
}
