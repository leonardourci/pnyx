import { useEffect, useRef, useState } from 'react'
import type { HydraSummary } from '#app/server-hydras.ts'
import type { Command } from '#web-app/connection.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { HydraLabel } from '#web-hydra/hydra-title.tsx'
import { ICON_SIZE } from '#web-shared/icons.tsx'

export function HydraRemoval({
  hydras,
  command,
  connected,
  showConfirmation,
}: {
  hydras: HydraSummary[]
  command: Command
  connected: boolean
  showConfirmation(): void
}) {
  const [
    error,
    setError,
  ] = useState('')

  const currentVisit = useRef(true)
  useEffect(
    () => {
      currentVisit.current = true

      return () => {
        currentVisit.current = false
      }
    },
    [],
  )
  const pending = useRef(new Set<string>())
  const [
    pendingIds,
    setPendingIds,
  ] = useState<string[]>([])

  return (
    <section className="my-3 rounded-xl border border-gold-line p-4" aria-label="Hydras">
      <h2>Hydras</h2>
      {error && <p role="alert">{error}</p>}
      {hydras.map(hydra => (
        <div key={hydra.id} className="mt-3 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2"><HydraLabel name={hydra.name} icon={hydra.icon} size={ICON_SIZE.control} /></span>
          <Button
            aria-label={`Remove ${hydra.name}`}
            disabled={!connected || pendingIds.includes(hydra.id)}
            onClick={async () => {
              if (pending.current.has(hydra.id)) {
                return
              }

              pending.current.add(hydra.id)
              setPendingIds([...pending.current])

              try {
                await command({
                  name: 'hydra',
                  args: [
                    'remove',
                    hydra.id,
                  ],
                })
                setError('')

                if (currentVisit.current) {
                  showConfirmation()
                }
              } catch (error) {
                setError(error instanceof Error ? error.message : String(error))
              } finally {
                pending.current.delete(hydra.id)
                setPendingIds([...pending.current])
              }
            }}
          >Remove
          </Button>
        </div>
      ))}
    </section>
  )
}
