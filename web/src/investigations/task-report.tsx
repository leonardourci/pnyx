import { useEffect, useState } from 'react'
import type { Card } from '../../../src/core/model.ts'
import { CollapsibleText } from '../shared/ui/disclosure.tsx'
import { relativeTime } from '../hydra/brief.ts'
import type { Command } from '../app/connection.ts'

// A task's stored investigation report, read when its card opens.
export function TaskReport({
  card,
  command,
  connected,
}: {
  card: Card
  command: Command
  connected: boolean
}) {
  const [
    report,
    setReport,
  ] = useState<string | null>(null)
  const [
    error,
    setError,
  ] = useState('')
  const stored = card.report?.id

  useEffect(
    () => {
      if (!stored || !connected) {
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

          if (active) {
            setReport(String(receipt.report))
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

  return (
    <section className="task-report" aria-label="Report">
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
