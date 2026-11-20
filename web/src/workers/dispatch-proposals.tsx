import { SettingsBox } from '#web-shared/ui/settings-box.tsx'
import { useState } from 'react'
import type { HydraState } from '#app/model.ts'
import type { DispatchChange } from '#workers/dispatch-check.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import type { Command } from '#web-app/connection.ts'
import { DISPATCH_CHANGED, useHeadsDispatch } from './heads-dispatch.ts'

const shown = ({ value }: { value: unknown }) => value === undefined ? 'none' : JSON.stringify(value)
const COMMAND_PREVIEW_FIELDS = [
  'name',
  'args',
  'cwd',
]

function useDispatchProposals({
  state,
  command,
  notify,
}: {
  state: HydraState
  command: Command
  notify({ text }: { text: string }): void
}) {
  const [
    busy,
    setBusy,
  ] = useState<string>()
  const statuses = useHeadsDispatch({ command }).effective?.proposals ?? []

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

  const proposals = (state.dispatchProposals ?? []).map(proposal => ({
    proposal,
    status: statuses.find(item => item.token === proposal.token),
    changes: proposal.kind === 'dispatch' ? JSON.parse(proposal.before) as DispatchChange[] : [],
    name: proposal.kind === 'command' ? 'approval' as const : 'rule' as const,
  }))

  return {
    proposals,
    busy,
    resolve,
  }
}

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
  const {
    proposals,
    busy,
    resolve,
  } = useDispatchProposals({
    state,
    command,
    notify,
  })

  return proposals.map(({
    proposal,
    status,
    changes,
    name,
  }) => {
    const note = status?.reason
      ? `${status.reason}. Dismiss it and ask Hydra again.`
      : 'Hydra proposes this change. Confirm to apply it.'
    const applying = proposal.status === 'applying'
    const commandApplying = proposal.kind === 'command' && applying
    const applyingMessage = proposal.kind === 'dispatch'
      ? 'Applying… Dismiss hides this question. The action continues.'
      : 'Applying…'
    const commandPreview = proposal.kind === 'command' ? JSON.stringify(
      JSON.parse(proposal.value),
      COMMAND_PREVIEW_FIELDS,
      2,
    ) : undefined

    return (
      <SettingsBox key={proposal.token} aria-label="Pending owner question">
        <strong>{proposal.summary}</strong>
        <p className="muted">{note}</p>
        {proposal.error && <p role="alert">{proposal.error}</p>}
        {applying && <p role="status">{applyingMessage}</p>}
        {proposal.kind === 'dispatch' ? (
          <ul>
            {changes.map(change => (
              <li key={change.path}>
                <code>{change.path}</code> {shown({ value: change.before })}
                {' → '}
                {shown({ value: change.after })}
              </li>
            ))}
          </ul>
        ) : (
          <pre>{commandPreview}</pre>
        )}
        <div className="row">
          {!status?.outOfDate && (
            <Button
              variant="primary"
              disabled={!connected || Boolean(busy) || Boolean(proposal.status)}
              onClick={() => void resolve({
                name,
                token: proposal.token,
                action: 'confirm',
              })}
            >Confirm
            </Button>
          )}
          <Button
            disabled={!connected || Boolean(busy) || commandApplying}
            onClick={() => void resolve({
              name,
              token: proposal.token,
              action: 'dismiss',
            })}
          >Dismiss
          </Button>
        </div>
      </SettingsBox>
    )
  })
}
