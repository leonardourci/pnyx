import { useLayoutEffect, useRef, useState } from 'react'
import type { TitanSummary } from '#app/server-hydras.ts'
import type { Command } from '#web-app/connection.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { TitanLabel } from '#web-titan/hydra-title.tsx'
import { ICON_SIZE } from '#web-shared/icons.tsx'

export function TitanRemoval({
  hydras,
  command,
  connected,
}: {
  hydras: TitanSummary[]
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
      {hydras.map(hydra => (
        <div key={hydra.id} className="mt-3 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2"><TitanLabel name={hydra.name} icon={hydra.icon} size={ICON_SIZE.control} /></span>
          <Button
            aria-label={`Remove ${hydra.name}`}
            disabled={!connected || pendingIds.includes(hydra.id)}
            onClick={async () => {
              setError('')
              setPendingIds(ids => [
                ...ids,
                hydra.id,
              ])

              try {
                await command({
                  name: 'hydra',
                  args: [
                    'remove',
                    hydra.id,
                  ],
                })
              } catch (error) {
                if (currentVisit.current) {
                  setError(error instanceof Error ? error.message : String(error))
                }
              } finally {
                if (currentVisit.current) {
                  setPendingIds(ids => ids.filter(id => id !== hydra.id))
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
