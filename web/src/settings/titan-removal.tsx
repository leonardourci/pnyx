import { useLayoutEffect, useRef, useState } from 'react'
import type { TitanSummary } from '#app/server-titans.ts'
import type { Command } from '#web-app/connection.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { TitanLabel } from '#web-titan/titan-title.tsx'
import { ICON_SIZE } from '#web-shared/icons.tsx'

export function TitanRemoval({
  titans,
  command,
  connected,
}: {
  titans: TitanSummary[]
  command: Command
  connected: boolean
}) {
  const [
    error,
    setError,
  ] = useState('')

  const currentVisit = useRef(true)
  useLayoutEffect(
    () => {
      currentVisit.current = true

      return () => {
        currentVisit.current = false
      }
    },
    [],
  )
  const [
    pendingIds,
    setPendingIds,
  ] = useState<string[]>([])

  return (
    <section className="my-3 rounded-xl border border-gold-line p-4" aria-label="Titans">
      <h2>Titans</h2>
      {error && <p role="alert">{error}</p>}
      {titans.map(titan => (
        <div key={titan.id} className="mt-3 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2"><TitanLabel name={titan.name} icon={titan.icon} size={ICON_SIZE.control} /></span>
          <Button
            aria-label={`Remove ${titan.name}`}
            disabled={!connected || pendingIds.includes(titan.id)}
            onClick={async () => {
              setError('')
              setPendingIds(ids => [
                ...ids,
                titan.id,
              ])

              try {
                await command({
                  name: 'titan',
                  args: [
                    'remove',
                    titan.id,
                  ],
                })
              } catch (error) {
                if (currentVisit.current) {
                  setError(error instanceof Error ? error.message : String(error))
                }
              } finally {
                if (currentVisit.current) {
                  setPendingIds(ids => ids.filter(id => id !== titan.id))
                }
              }
            }}
          >Remove
          </Button>
        </div>
      ))}
    </section>
  )
}
