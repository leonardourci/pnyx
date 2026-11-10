import { background } from '#app/background.ts'
import { closeLogs, openLogs, setLogMode, type LogMode } from '#app/diagnostics.ts'
import type { Settings } from '#settings/model.ts'
import { cleanLogs, MB } from './log-files.ts'
import { startProcessLines } from './process-line.ts'

// Deletes expired and over-size logs this often, so detailed logging passes the size cap by at most a minute of lines.
export const LOG_CLEAN_MS = 60_000

type LogSettings = Pick<Settings, 'logs' | 'logDays' | 'logMaxMB'>

// The server's logs: its own folder, the level and retention from the settings, the process line and cleanup.
export function startServerLogs({
  settings,
  processLineMs,
}: {
  settings: LogSettings
  processLineMs?: number
}) {
  let current = settings
  let processLines: ReturnType<typeof startProcessLines> | undefined

  const cleanNow = () => background({
    name: 'log cleanup',
    run: () => cleanLogs({
      days: current.logDays,
      maxBytes: current.logMaxMB * MB,
    }),
  })

  // The process line samples the event loop and garbage collection, so it runs only while logging is on.
  const follow = ({ mode }: { mode: LogMode }) => {
    setLogMode({ mode })

    if (mode === 'off') {
      processLines?.stop()
      processLines = undefined
    } else if (!processLines) {
      processLines = startProcessLines({ every: processLineMs })
    }
  }

  openLogs()
  follow({ mode: settings.logs })
  cleanNow()
  const timer = setInterval(
    cleanNow,
    LOG_CLEAN_MS,
  ).unref()

  return {
    apply({ settings: next }: { settings: LogSettings }) {
      const daysChanged = next.logDays !== current.logDays
      const sizeChanged = next.logMaxMB !== current.logMaxMB
      const retentionChanged = daysChanged || sizeChanged
      current = next
      follow({ mode: next.logs })

      if (retentionChanged) {
        cleanNow()
      }
    },
    close() {
      clearInterval(timer)
      processLines?.stop()
      closeLogs()
    },
  }
}
