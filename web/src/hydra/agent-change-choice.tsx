import { background } from '#app/background.ts'
import { useEffect, useState } from 'react'
import type { HydraState } from '#app/model.ts'
import type { Command } from '#web-app/connection.ts'
import { Button } from '#web-shared/ui/controls.tsx'

export function AgentChangeChoice({
  state,
  command,
  connected,
  notify,
}: {
  state: HydraState
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const change = state.hydraAgentChange
  const [
    availability,
    setAvailability,
  ] = useState('unknown')
  const key = JSON.stringify(change?.next)

  useEffect(
    () => {
      if (!connected || !key) {
        return
      }

      let cancelled = false
      setAvailability('unknown')
      background({
        name: 'selected agent usage',
        run: async () => {
          try {
            const result = await command({
              name: 'hydra-agent-usage',
              args: [key],
            })

            if (!cancelled) {
              setAvailability(String(result.availability))
            }
          } catch {
            // Missing quota evidence stays unknown and never blocks the owner's choice.
            if (!cancelled) {
              setAvailability('unknown')
            }
          }
        },
      })

      return () => {
        cancelled = true
      }
    },
    [
      key,
      connected,
      command,
    ],
  )

  if (!change) {
    return null
  }

  const running = change.state === 'running'

  const choose = async ({ choice }: { choice: string }) => {
    try {
      await command({
        name: 'hydra-agent-change',
        args: [
          change.id,
          choice,
        ],
      })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  const usage = {
    available: 'Usage available for the selected agent.',
    exhausted: 'No usage remaining for the selected agent.',
    unknown: 'Usage for the selected agent is unknown.',
  }[availability]

  const title = running ? 'Preparing the conversation…' : 'Your message is held'
  const explanation = change.kind === 'agent' ? 'Compact before switching agents.' : 'Choose how to continue after changing effort.'
  const actionsDisabled = !connected || running
  const allowNeither = change.kind === 'effort'

  return (
    <div className="agent-change-choice" role="region" aria-label="Continue with the selected agent">
      <strong>{title}</strong>
      <p>{explanation} {usage}</p>
      {change.error && <p role="alert">{change.error}</p>}
      <div className="agent-change-actions">
        <Button disabled={actionsDisabled} onClick={() => choose({ choice: 'inscribe' })}>Inscribe + compact <small className="muted">Recommended</small></Button>
        <Button disabled={actionsDisabled} onClick={() => choose({ choice: 'compact' })}>Compact only</Button>
        {allowNeither && <Button disabled={actionsDisabled} onClick={() => choose({ choice: 'neither' })}>Neither <small className="muted">Not recommended</small></Button>}
      </div>
    </div>
  )
}
