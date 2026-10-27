import { useState } from 'react'
import type { HydraState } from '../../../src/app/model.ts'
import { Button } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'
import { DISPATCH_CHANGED } from './heads-dispatch.ts'

export function DispatchProposals({
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
  const [
    busy,
    setBusy,
  ] = useState<string>()

  const resolve = async ({
    token,
    action,
    name,
  }: {
    name: 'rule' | 'approval'
    token: string
    action: 'confirm' | 'dismiss'
  }) => {
    setBusy(token)

    try {
      await command({
        name,
        args: [
          action,
          token,
          ...(action === 'confirm' ? [
            '--confirm',
            token,
          ] : []),
        ],
      })
      window.dispatchEvent(new Event(DISPATCH_CHANGED))
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(undefined)
    }
  }

  return (state.dispatchProposals ?? []).map(proposal => (
    <section key={proposal.token} className="settings-box" aria-label="Pending owner question">
      <strong>{proposal.summary}</strong>
      <p className="muted">Hydra proposes this change. Confirm to apply it.</p>
      {proposal.error && <p role="alert">{proposal.error}</p>}
      {proposal.status === 'applying' && <p role="status">Applying… Dismiss hides this question without cancelling the action.</p>}
      <pre>{JSON.stringify(
        JSON.parse(proposal.value),
        null,
        2,
      )}
      </pre>
      <div className="row">
        <Button
          variant="primary"
          disabled={!connected || Boolean(busy) || Boolean(proposal.status)}
          onClick={() => void resolve({
            name: proposal.kind === 'command' ? 'approval' : 'rule',
            token: proposal.token,
            action: 'confirm',
          })}
        >Confirm
        </Button>
        <Button
          disabled={!connected || Boolean(busy)}
          onClick={() => void resolve({
            name: proposal.kind === 'command' ? 'approval' : 'rule',
            token: proposal.token,
            action: 'dismiss',
          })}
        >Dismiss
        </Button>
      </div>
    </section>
  ))
}
