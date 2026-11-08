import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { asRecord } from '#app/command-validation.ts'
import type { HydraEvent } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import { pnyxHome } from '#store/paths.ts'

export const DEBUG_LIMIT = 50
export const DEBUG_MAX = 200
const LOG_BYTES = 512 * 1024
const CURSOR_BYTES = 2048

export interface TimelineRow {
  source: 'events' | 'service'
  id: string
  at: string
  type: string
  seq?: number
  offset?: number
  taskId?: string
  cardId?: string
  agentId?: string
  commandId?: string
  originId?: string
  originAdapter?: string
  sessionId?: string
  recordedSessionId?: string
  nativeId?: string
  originInstanceId?: string
  messageId?: string
  batchId?: string
  correlationId?: string
  transaction?: string
  causeId?: string
  state?: string
  attempt?: number
}

export interface TimelineFilter {
  task?: string
  message?: string
  session?: string
  batch?: string
  since?: number
  until?: number
  cursor?: string
  limit: number
}

const string = ({ value }: { value: unknown }) => typeof value === 'string' ? value : undefined

export function eventRow({ event }: { event: HydraEvent }): TimelineRow {
  const data = asRecord({ value: event.data })
  const origin = asRecord({ value: data?.source })
  const actualSession = event.type === 'diagnostic.retry' ? event.data.sessionId : event.sessionId
  let batchId: string | undefined

  if (event.type === 'hydra.helper-started') {
    batchId = event.data.id
  } else if (event.type === 'hydra.helper-finished') {
    batchId = event.data.batch
  }

  return {
    source: 'events',
    id: event.id,
    seq: event.seq,
    at: event.at,
    type: event.type,
    taskId: event.taskId ?? event.cardId,
    cardId: event.cardId,
    agentId: event.agentId,
    commandId: event.commandId,
    originId: string({ value: origin?.objectId }),
    originAdapter: string({ value: origin?.adapter }),
    originInstanceId: string({ value: origin?.instanceId }),
    sessionId: actualSession,
    recordedSessionId: actualSession === event.sessionId ? undefined : event.sessionId,
    nativeId: string({ value: data?.nativeId }),
    messageId: event.messageId
      ?? string({ value: data?.messageId })
      ?? string({ value: data?.reply })
      ?? string({ value: data?.message }),
    batchId,
    transaction: event.transaction,
    causeId: string({ value: data?.of }),
    state: event.type === 'diagnostic.retry' ? event.data.status : string({ value: data?.state }),
    attempt: event.type === 'diagnostic.retry' ? event.data.number : undefined,
  }
}

export function serviceRows({ hydraId }: { hydraId: string }): {
  rows: TimelineRow[]
  truncated: boolean
} {
  const path = join(
    pnyxHome(),
    'service.log',
  )

  if (!existsSync(path)) {
    return {
      rows: [],
      truncated: false,
    }
  }

  const fd = openSync(
    path,
    'r',
  )

  try {
    const size = fstatSync(fd).size
    const start = Math.max(
      0,
      size - LOG_BYTES,
    )
    const buffer = Buffer.alloc(size - start)
    readSync(
      fd,
      buffer,
      0,
      buffer.length,
      start,
    )
    const rows: TimelineRow[] = []
    let offset = start === 0 ? 0 : buffer.indexOf(10) + 1

    for (; offset < buffer.length;) {
      const end = buffer.indexOf(
        10,
        offset,
      )

      if (end < 0) {
        break
      }

      const sourceOffset = start + offset
      const line = buffer.toString(
        'utf8',
        offset,
        end,
      )
      offset = end + 1
      let value: unknown

      try {
        value = JSON.parse(line)
      } catch {
        continue
      }

      const record = asRecord({ value })

      if (record?.v !== 1 || record.hydraId !== hydraId || typeof record.operationId !== 'string'
        || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))
        || typeof record.operation !== 'string') {
        continue
      }

      rows.push({
        source: 'service',
        id: record.operationId,
        offset: sourceOffset,
        at: record.at,
        type: record.operation,
        seq: Number.isInteger(record.eventSeq) ? Number(record.eventSeq) : undefined,
        taskId: string({ value: record.taskId }),
        sessionId: string({ value: record.sessionId }),
        correlationId: string({ value: record.correlationId }),
      })
    }

    return {
      rows,
      truncated: start > 0,
    }
  } finally {
    closeSync(fd)
  }
}

function compare({
  left,
  right,
}: {
  left: TimelineRow
  right: TimelineRow
}): number {
  return Date.parse(right.at) - Date.parse(left.at)
    || (right.seq ?? 0) - (left.seq ?? 0)
    || left.source.localeCompare(right.source)
    || (right.offset ?? 0) - (left.offset ?? 0)
    || left.id.localeCompare(right.id)
}

function readCursor({ cursor }: { cursor?: string }): TimelineRow | undefined {
  if (cursor === undefined) {
    return undefined
  }

  try {
    if (cursor.length > CURSOR_BYTES) {
      throw new Error('too long')
    }

    const row = asRecord({
      value: JSON.parse(Buffer.from(
        cursor,
        'base64url',
      ).toString('utf8')),
    })

    if (!row || ![
      'events',
      'service',
    ].includes(String(row.source)) || typeof row.id !== 'string'
      || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))
      || (row.seq !== undefined && !Number.isInteger(row.seq))
      || (row.offset !== undefined && !Number.isInteger(row.offset))) {
      throw new Error('invalid fields')
    }

    return {
      source: row.source === 'events' ? 'events' : 'service',
      id: row.id,
      at: row.at,
      type: '',
      seq: row.seq === undefined ? undefined : Number(row.seq),
      offset: row.offset === undefined ? undefined : Number(row.offset),
    }
  } catch {
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: 'Invalid timeline cursor',
    })
  }
}

export function timeline({
  events,
  service = [],
  filter,
}: {
  events: HydraEvent[]
  service?: TimelineRow[]
  filter: TimelineFilter
}) {
  const cursor = readCursor({ cursor: filter.cursor })
  const rows: TimelineRow[] = []
  const batchTasks = new Map<string, string[]>()

  for (const event of events) {
    if (event.type === 'hydra.helper-started') {
      batchTasks.set(
        event.data.id,
        event.data.tasks,
      )
    }
  }

  const collect = ({
    row,
    event,
  }: {
    row: TimelineRow
    event?: HydraEvent
  }) => {
    const at = Date.parse(row.at)
    const acknowledged = event?.type === 'hydra.helper-acknowledged' ? event.data.batches : []
    const relatedBatches = acknowledged.slice()

    if (row.batchId) {
      relatedBatches.push(row.batchId)
    }

    const task = filter.task
    const taskMatches = !task || row.taskId === task || event?.cardId === task
      || relatedBatches.some(batch => batchTasks.get(batch)?.includes(task))
    const messageMatches = !filter.message || row.messageId === filter.message
      || row.id === filter.message || row.correlationId === filter.message
      || row.nativeId === filter.message
    const sessionMatches = !filter.session || row.sessionId === filter.session
      || row.recordedSessionId === filter.session
    const batchMatches = !filter.batch || row.batchId === filter.batch
      || row.correlationId === filter.batch || acknowledged.includes(filter.batch)

    if (!taskMatches || !messageMatches || !batchMatches || !sessionMatches
      || (filter.since !== undefined && at < filter.since)
      || (filter.until !== undefined && at > filter.until)
      || (cursor && compare({
        left: row,
        right: cursor,
      }) <= 0)) {
      return
    }

    rows.push(row)
    rows.sort((
      left,
      right,
    ) => compare({
      left,
      right,
    }))

    if (rows.length > filter.limit + 1) {
      rows.pop()
    }
  }

  for (const event of events) {
    collect({
      row: eventRow({ event }),
      event,
    })
  }

  for (const row of service) {
    collect({ row })
  }

  const more = rows.length > filter.limit
  const page = rows.slice(
    0,
    filter.limit,
  )
  const last = page.at(-1)

  return {
    entries: page,
    more,
    cursor: more && last ? Buffer.from(JSON.stringify({
      source: last.source,
      id: last.id,
      at: last.at,
      seq: last.seq,
      offset: last.offset,
    })).toString('base64url') : undefined,
  }
}
