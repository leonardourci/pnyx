import { useEffect, useState } from 'react'
import type { Card } from '#tasks/model.ts'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { relativeTime } from '#web-tasks/brief.ts'
import type { Command } from '#web-app/connection.ts'

// Reports already read, by report id, for the life of the page, so switching back to Activity shows one at once.
const reports = new Map<string, string>()

// A task's stored investigation report, read when its card's Activity tab first shows it.
export function TaskReport({
  card,
  command,
  connected,
}: {
  card: Card
  command: Command
  connected: boolean
}) {
  const stored = card.report?.id
  const [
    report,
    setReport,
  ] = useState<string | null>(() => (stored ? reports.get(stored) : undefined) ?? null)
  const [
    error,
    setError,
  ] = useState('')

  useEffect(
    () => {
      if (!stored) {
        return
      }

      const kept = reports.get(stored)

      if (kept !== undefined) {
        setReport(kept)

        return
      }

      if (!connected) {
        return
      }

      let active = true

      const load = async () => {
        try {
          const receipt = await command({
            name: 'task',
            args: [
              'report',
              card.id,
            ],
          })

          const text = String(receipt.report)
          reports.set(
            stored,
            text,
          )

          if (active) {
            setReport(text)
          }
        } catch (failure) {
          if (active) {
            setError((failure as Error).message)
          }
        }
      }

      setError('')
      load()

      return () => {
        active = false
      }
    },
    [
      card.id,
      command,
      connected,
      stored,
    ],
  )

  if (!card.report) {
    return null
  }

  const loading = connected && report === null && !error

  return (
    <section className="task-report" aria-label="Report" aria-busy={loading}>
      <strong className="eyebrow">Report</strong>
      <span className="muted small">Stored {relativeTime({
        at: card.report.at,
        now: Date.now(),
      })}
      </span>
      {error && <span className="muted small">{error}</span>}
      {report !== null && <div className="task-report-body"><CollapsibleText text={report} /></div>}
    </section>
  )
}
