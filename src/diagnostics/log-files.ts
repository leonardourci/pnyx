import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DAY_FILE, logsDir, releaseLogFile } from '#app/diagnostics.ts'

const DAY_MS = 24 * 60 * 60 * 1000
export const MB = 1024 * 1024

export interface LogFile {
  day: string
  path: string
  bytes: number
}

// Every day's file, oldest first.
export function logFiles(): LogFile[] {
  const dir = logsDir()

  if (!existsSync(dir)) {
    return []
  }

  return readdirSync(dir).flatMap(name => {
    const day = DAY_FILE.exec(name)?.[1]

    if (!day) {
      return []
    }

    const path = join(
      dir,
      name,
    )

    return [
      {
        day,
        path,
        bytes: statSync(path).size,
      },
    ]
  })
    .toSorted((
      a,
      b,
    ) => a.day.localeCompare(b.day))
}

function remove({ files }: { files: LogFile[] }) {
  for (const file of files) {
    rmSync(
      file.path,
      { force: true },
    )
  }

  // The current day's file may be among them; the next line starts it again.
  releaseLogFile()

  return {
    files: files.length,
    bytes: files.reduce(
      (
        sum,
        file,
      ) => sum + file.bytes,
      0,
    ),
  }
}

// Keeps the last `days` days, today included, then deletes the oldest files until the rest fit in `maxBytes`.
export function cleanLogs({
  days,
  maxBytes,
  now = Date.now(),
}: {
  days: number
  maxBytes: number
  now?: number
}) {
  const oldestKept = new Date(now - (days - 1) * DAY_MS).toISOString()
    .slice(
      0,
      10,
    )
  const files = logFiles()
  const expired = files.filter(file => file.day < oldestKept)
  const kept = files.filter(file => file.day >= oldestKept)
  let total = kept.reduce(
    (
      sum,
      file,
    ) => sum + file.bytes,
    0,
  )
  const overSize: LogFile[] = []

  for (const file of kept) {
    if (total <= maxBytes) {
      break
    }

    overSize.push(file)
    total -= file.bytes
  }

  const deleted = [
    ...expired,
    ...overSize,
  ]

  if (!deleted.length) {
    return {
      files: 0,
      bytes: 0,
    }
  }

  return remove({ files: deleted })
}

export const clearLogs = () => remove({ files: logFiles() })
