import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DAY_FILE, logsDir, releaseLogFile, setTodayFull } from '#app/diagnostics.ts'
import { logDay } from '#app/log-line.ts'
import { keptDays } from './retention.ts'

export const MB = 1024 * 1024

interface LogFile {
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

  // The current day's file may be among them; the next line starts it again, empty.
  releaseLogFile()
  setTodayFull({ full: false })

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

// Deletes the days the retention rule does not keep, and tells the writer when today's file alone passes the cap.
export function cleanLogs({
  days,
  maxBytes,
  now = Date.now(),
}: {
  days: number
  maxBytes: number
  now?: number
}) {
  const files = logFiles()
  const today = logDay({ at: new Date(now).toISOString() })
  const retained = keptDays({
    days: files,
    keepDays: days,
    maxBytes,
    today,
  })
  setTodayFull({
    full: retained.full,
    maxBytes,
  })
  const deleted = files.filter(file => !retained.kept.has(file.day))

  if (!deleted.length) {
    return {
      files: 0,
      bytes: 0,
    }
  }

  return remove({ files: deleted })
}

export const clearLogs = () => remove({ files: logFiles() })
