import { closeSync, constants, fdatasyncSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname } from 'node:path'
import { HydraError } from './errors.ts'
import { privateDir, syncDirectory, writeOpenFile } from './storage.ts'

const READ_BYTES = 64 * 1024
const AUTHORS = new Set([
  'owner',
  'hydra',
  'worker',
  'daemon',
])
const UTF8 = new TextDecoder(
  'utf-8',
  { fatal: true },
)

export interface LogPosition {
  bytes: number
  n: number
}

export interface LogFact {
  at: string
  by: 'owner' | 'hydra' | 'worker' | 'daemon'
  t: string
  id: string
  [field: string]: unknown
}

export interface LogEntry extends LogFact {
  n: number
}

const EMPTY: LogPosition = {
  bytes: 0,
  n: 0,
}

function positionError({ path }: { path: string }): HydraError {
  return new HydraError({
    message: `log position does not match ${path}`,
    code: 'LOG_POSITION',
  })
}

function corrupt({
  path,
  offset,
}: {
  path: string
  offset: number
}): HydraError {
  return new HydraError({
    message: `${path} is corrupt at byte ${offset}`,
    code: 'LOG_CORRUPT',
  })
}

export function validLogPosition({ position }: { position: unknown }): boolean {
  const cursor = position as Partial<LogPosition> | null

  return !!cursor && typeof cursor === 'object'
    && Number.isSafeInteger(cursor.bytes) && cursor.bytes! >= 0
    && Number.isSafeInteger(cursor.n) && cursor.n! >= 0
    && (cursor.bytes === 0) === (cursor.n === 0)
}

function entryOf({
  value,
  path,
  offset,
  n,
  writing = false,
}: {
  value: unknown
  path: string
  offset: number
  n: number
  writing?: boolean
}): LogEntry {
  const entry = value as Partial<LogEntry> | null

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || entry.n !== n || !Number.isSafeInteger(entry.n)
    || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))
    || typeof entry.by !== 'string' || !AUTHORS.has(entry.by)
    || typeof entry.t !== 'string' || !entry.t
    || typeof entry.id !== 'string' || !entry.id) {
    if (writing) {
      throw new HydraError({
        code: 'INVALID_EVENT',
        message: 'invalid native fact header',
      })
    }

    throw corrupt({
      path,
      offset,
    })
  }

  return entry as LogEntry
}

function truncateTail({
  fd,
  bytes,
}: {
  fd: number
  bytes: number
}): void {
  ftruncateSync(
    fd,
    bytes,
  )
  fsyncSync(fd)
}

export function readLog({
  path,
  after = EMPTY,
  accept,
}: {
  path: string
  after?: LogPosition
  accept({ entry }: { entry: LogEntry }): void
}): LogPosition {
  if (!validLogPosition({ position: after })) {
    throw positionError({ path })
  }

  let fd: number
  const found = lstatSync(
    path,
    { throwIfNoEntry: false },
  )

  if (found && !found.isFile()) {
    throw corrupt({
      path,
      offset: 0,
    })
  }

  try {
    fd = openSync(
      path,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') {
      throw corrupt({
        path,
        offset: 0,
      })
    }

    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }

    if (after.bytes) {
      throw positionError({ path })
    }

    return { ...EMPTY }
  }

  try {
    const opened = fstatSync(fd)

    if (!opened.isFile()) {
      throw corrupt({
        path,
        offset: 0,
      })
    }

    const size = opened.size

    if (after.bytes > size) {
      throw positionError({ path })
    }

    if (after.bytes) {
      const boundary = Buffer.allocUnsafe(1)
      const bytes = readSync(
        fd,
        boundary,
        0,
        1,
        after.bytes - 1,
      )

      if (bytes !== 1 || boundary[0] !== 10) {
        throw positionError({ path })
      }
    }

    const hasUnverifiedTail = size > after.bytes

    if (hasUnverifiedTail) {
      fdatasyncSync(fd)
    }

    let pending: Buffer = Buffer.alloc(0)
    let offset = after.bytes
    let readAt = after.bytes
    let n = after.n

    while (readAt < size) {
      const chunk = Buffer.allocUnsafe(Math.min(
        READ_BYTES,
        size - readAt,
      ))
      const bytes = readSync(
        fd,
        chunk,
        0,
        chunk.length,
        readAt,
      )

      if (!bytes) {
        throw new HydraError({
          message: `${path} changed while reading`,
          code: 'LOG_CHANGED',
        })
      }

      readAt += bytes
      pending = Buffer.concat([
        pending,
        chunk.subarray(
          0,
          bytes,
        ),
      ])
      let start = 0

      for (let end = pending.indexOf(10); end !== -1; end = pending.indexOf(
        10,
        start,
      )) {
        const lineOffset = offset + start
        let value: unknown

        try {
          value = JSON.parse(UTF8.decode(pending.subarray(
            start,
            end,
          )))
        } catch (error) {
          if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
            throw error
          }

          const last = readAt === size && end + 1 === pending.length

          if (!last) {
            throw corrupt({
              path,
              offset: lineOffset,
            })
          }

          truncateTail({
            fd,
            bytes: lineOffset,
          })

          return {
            bytes: lineOffset,
            n,
          }
        }

        const entry = entryOf({
          value,
          path,
          offset: lineOffset,
          n: n + 1,
        })
        accept({ entry })
        n = entry.n
        start = end + 1
      }

      offset += start
      pending = pending.subarray(start)
    }

    if (pending.length) {
      truncateTail({
        fd,
        bytes: offset,
      })
    }

    return {
      bytes: offset,
      n,
    }
  } finally {
    closeSync(fd)
  }
}

export function prepareLog({
  path,
  after,
  entries,
}: {
  path: string
  after: LogPosition
  entries: readonly LogFact[]
}): {
  data: Buffer
  entries: LogEntry[]
  position: LogPosition
} {
  if (!validLogPosition({ position: after })) {
    throw positionError({ path })
  }

  const numberedEntries: LogEntry[] = []
  const lines = entries.map((
    entry,
    index,
  ) => {
    const {
      at,
      by,
      t,
      id,
      ...fields
    } = entry

    if (Object.hasOwn(
      fields,
      'n',
    )) {
      throw new HydraError({
        message: 'the log assigns its own line numbers',
        code: 'INVALID_EVENT',
      })
    }

    const numbered = entryOf({
      value: {
        n: after.n + index + 1,
        at,
        by,
        t,
        id,
        ...fields,
      },
      path,
      offset: after.bytes,
      n: after.n + index + 1,
      writing: true,
    })
    numberedEntries.push(numbered)

    return `${JSON.stringify(numbered)}\n`
  })
  const buffer = Buffer.from(lines.join(''))

  return {
    data: buffer,
    entries: numberedEntries,
    position: {
      bytes: after.bytes + buffer.length,
      n: after.n + entries.length,
    },
  }
}

export function appendLog({
  path,
  after,
  entries,
}: {
  path: string
  after: LogPosition
  entries: readonly LogFact[]
}): LogPosition {
  const prepared = prepareLog({
    path,
    after,
    entries,
  })

  if (!entries.length) {
    return prepared.position
  }

  const existing = lstatSync(
    path,
    { throwIfNoEntry: false },
  )

  if (existing && !existing.isFile()) {
    throw corrupt({
      path,
      offset: 0,
    })
  }

  if ((existing?.size ?? 0) !== after.bytes) {
    throw new HydraError({
      message: `${path} changed before append`,
      code: 'LOG_CHANGED',
    })
  }

  privateDir({ dir: dirname(path) })
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  )

  try {
    const opened = fstatSync(fd)

    if (!opened.isFile()) {
      throw corrupt({
        path,
        offset: 0,
      })
    }

    if (opened.size !== after.bytes) {
      throw new HydraError({
        message: `${path} changed before append`,
        code: 'LOG_CHANGED',
      })
    }

    writeOpenFile({
      fd,
      path,
      data: prepared.data,
      dataOnly: true,
    })

    if (!existing) {
      syncDirectory({ dir: dirname(path) })
    }

    return prepared.position
  } finally {
    closeSync(fd)
  }
}
