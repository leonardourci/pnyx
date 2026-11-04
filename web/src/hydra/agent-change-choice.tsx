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
  const key = JSON.stringify(change?.next ?? state.config?.hydra.agent)

  useEffect(
    () => {
      if (!connected || !key) {
        return
      }

      let cancelled = false
      setAvailability('unknown')
      void command({
        name: 'hydra-agent-usage',
        args: [key],
      })
        .then(result => {
          if (!cancelled) {
            setAvailability(String(result.availability))
          }
        })
        .catch(() => {})

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

  return (
    <div className="agent-change-choice" role="region" aria-label="Continue with the selected agent">
      <strong>{running ? 'Preparing the conversation…' : 'Your message is held'}</strong>
      <p>{change.kind === 'agent' ? 'Compact before switching agents.' : 'Choose how to continue after changing effort.'} {usage}</p>
      {change.error && <p role="alert">{change.error}</p>}
      <div className="agent-change-actions">
        <Button disabled={!connected || running} onClick={() => choose({ choice: 'inscribe' })}>Inscribe + compact <small className="muted">Recommended</small></Button>
        <Button disabled={!connected || running} onClick={() => choose({ choice: 'compact' })}>Compact only</Button>
        {change.kind === 'effort' && <Button disabled={!connected || running} onClick={() => choose({ choice: 'neither' })}>Neither <small className="muted">Not recommended</small></Button>}
      </div>
    </div>
  )
}
