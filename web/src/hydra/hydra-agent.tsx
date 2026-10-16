import { useState } from 'react'
import type { AgentConfig, HydraState } from '../../../src/core/model.ts'
import { harnessControls } from '../../../src/core/control.ts'
import { Button } from '../components/ui/controls.tsx'
import { AgentPicker, PickerField } from './agent-picker.tsx'
import type { Command } from './connection.ts'

export function HydraAgent({ state, command, connected, notify }: {
  state: HydraState
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const agent = state.config?.agents?.hydra ?? { harness: 'claude' }

  if (state.config?.hydra.kind === 'firstmate') {
    return null
  }

  const summary = [agent.harness === 'claude' ? 'Claude Code' : 'Codex', agent.model ?? 'Default model', agent.mode, agent.effort, agent.fast ? 'Fast' : ''].filter(Boolean).join(' · ')

  return (
    <AgentPicker provider={agent.harness === 'claude' ? 'claude-code' : 'codex'} summary={summary}>
      {({ close }) => (
        <HydraSettings
          agent={agent}
          command={command}
          connected={connected}
          notify={notify}
          close={close}
        />
      )}
    </AgentPicker>
  )
}

function HydraSettings({ agent, command, connected, notify, close }: {
  agent: AgentConfig
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
  close(): void
}) {
  const [draft, setDraft] = useState(agent), [busy, setBusy] = useState(false)
  const controls = harnessControls({ provider: draft.harness === 'claude' ? 'claude-code' : 'codex', hosted: true })

  return (
    <div className="agent-configuration">
      <strong>Hydra’s next start</strong>
      <PickerField
        label="Agent"
        value={draft.harness}
        options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]}
        disabled={busy || !connected}
        onChange={({ value }) => {
          if (value === 'claude' || value === 'codex') {
            setDraft({ harness: value })
          }
        }}
      />
      {(['model', 'mode', 'effort'] as const).map(field => {
        const choices = controls?.controls.find(c => c.setting === field)?.options ?? []
        const value = draft[field] ?? ''
        const options = [{ value: '', label: `Default ${field}` }, ...choices.map(o => ({ value: o.value, label: o.label }))]

        if (value && !options.some(o => o.value === value)) {
          options.push({ value, label: value })
        }

        return (
          <PickerField
            key={field}
            label={field[0].toUpperCase() + field.slice(1)}
            value={value}
            options={options}
            disabled={busy || !connected}
            onChange={({ value }) => {
              setDraft(current => ({ ...current, [field]: value || undefined }))
            }}
          />
        )
      })}
      {controls?.controls.some(control => control.setting === 'fast') && (
        <PickerField
          label="Fast"
          value={draft.fast ? 'on' : 'off'}
          options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
          disabled={busy || !connected}
          onChange={({ value }) => setDraft(current => ({ ...current, fast: value === 'on' }))}
        />
      )}
      <p>Saved for Hydra’s next start. This does not start or attach an agent.</p>
      <Button
        variant="primary"
        disabled={busy || !connected}
        onClick={() => {
          setBusy(true)
          void command({ name: 'kind', args: ['set', 'hydra', '--harness', draft.harness, '--model', draft.model ?? '', '--mode', draft.mode ?? '', '--effort', draft.effort ?? '', '--fast', draft.fast === undefined ? 'default' : draft.fast ? 'on' : 'off', '--quota', draft.harness === agent.harness && draft.model === agent.model ? agent.quota ?? 'off' : 'off', '--event-id', crypto.randomUUID()] })
            .then(() => {
              notify({ text: 'Hydra agent saved for its next start.' }); close()
            }, (error: Error) => notify({ text: error.message }))
            .finally(() => setBusy(false))
        }}
      >Apply settings
      </Button>
    </div>
  )
}
