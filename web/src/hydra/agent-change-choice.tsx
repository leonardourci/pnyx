import { useId } from 'react'
import type { HydraState } from '#app/model.ts'
import type { HydraAgentChange } from '#hydra/model.ts'
import type { EffectiveDispatch } from '#workers/dispatch-config.ts'
import type { AgentConfig } from '#workers/model.ts'
import type { Command } from '#web-app/connection.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { useModels } from '#web-workers/agent-picker.tsx'
import { resolvedAccount, useHeadsDispatch } from '#web-workers/heads-dispatch.ts'

const COMPACT_WHY = 'Compacting first gives it a short summary of the chat since the last compaction.'

// The model picker's label, or the model id the "Switched to" divider shows until the catalog answers.
function useAgentName({
  agent,
  effective,
  command,
  connected,
}: {
  agent: AgentConfig
  effective?: EffectiveDispatch
  command: Command
  connected: boolean
}) {
  const account = resolvedAccount({
    effective,
    agent,
  })
  const catalog = useModels({
    harness: agent.harness,
    account,
    folder: account ? effective?.accounts[account]?.folder : undefined,
    command,
    connected: connected && account !== undefined,
  })
  const label = catalog.models?.find(option => option.value === agent.model)?.label

  return label ?? agent.model ?? agent.harness
}

function HeldMessageCard({
  change,
  command,
  connected,
  notify,
}: {
  change: HydraAgentChange
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const { effective } = useHeadsDispatch({ command })
  const next = useAgentName({
    agent: change.next,
    effective,
    command,
    connected,
  })
  const captionId = useId()

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

  const running = change.state === 'running'
  const effort = change.kind === 'effort'
  const actionsDisabled = !connected || running
  let title = effort ? `Changing effort to ${change.next.effort ?? 'default'}` : `Switching to ${next}`

  if (running) {
    title = 'Preparing the conversation…'
  }

  const explanation = effort ? `The agent continues at its new effort. ${COMPACT_WHY}` : `A new agent starts with fresh context. ${COMPACT_WHY}`
  const caption = effort
    ? 'Recommended: saves what\'s worth remembering first. Neither carries on without compacting and is not recommended.'
    : 'Recommended: saves what\'s worth remembering first.'

  return (
    <div className="agent-change-choice" role="region" aria-label="Continue with the selected agent">
      <strong>{title}</strong>
      <p>{explanation}</p>
      {change.error && <p role="alert">{change.error}</p>}
      <div className="agent-change-actions">
        <Button
          variant="primary"
          disabled={actionsDisabled}
          aria-describedby={captionId}
          onClick={() => choose({ choice: 'inscribe' })}
        >
          <Icon name="inscribe" size={16} />
          Inscribe +{' '}
          <Icon name="compact" size={16} />
          compact
        </Button>
        <Button variant="surface" disabled={actionsDisabled} onClick={() => choose({ choice: 'compact' })}>
          <Icon name="compact" size={16} />
          Compact only
        </Button>
        {effort && (
          <Button
            variant="surface"
            className="agent-change-neither"
            disabled={actionsDisabled}
            aria-describedby={captionId}
            onClick={() => choose({ choice: 'neither' })}
          >
            Neither
          </Button>
        )}
      </div>
      <p id={captionId} className="agent-change-caption">{caption}</p>
    </div>
  )
}

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

  if (!change) {
    return null
  }

  return (
    <HeldMessageCard
      change={change}
      command={command}
      connected={connected}
      notify={notify}
    />
  )
}
