import { useHeadsDispatch } from './heads-dispatch.ts'
import { useState } from 'react'
import type { AgentConfig, HydraState } from '../../../src/core/model.ts'
import { harnessControls } from '../../../src/core/control.ts'
import { PickerField } from './agent-picker.tsx'
import type { Command } from './connection.ts'

export function HydraAgent({ state, command, connected, notify }: {
  state: HydraState
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const { effective } = useHeadsDispatch({ command, seq: state.seq })
  const [busy, setBusy] = useState(false)
  const agent = state.config?.hydra.agent ?? effective?.dispatch.rules.hydra?.candidates[0] ?? effective?.dispatch.default[0] ?? { harness: 'claude' }
  const controls = harnessControls({ provider: agent.harness === 'claude' ? 'claude-code' : 'codex', hosted: true })

  if (state.config?.hydra.kind === 'firstmate') {
    return null
  }

  const save = ({ next }: { next: AgentConfig }) => {
    setBusy(true)
    void command({ name: 'hydra-agent', args: [JSON.stringify(next)] })
      .catch((error: Error) => notify({ text: error.message }))
      .finally(() => setBusy(false))
  }

  return (
    <div className="hydra-agent-pickers" aria-label="Hydra agent settings">
      <PickerField
        label="Harness"
        value={agent.harness}
        options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]}
        disabled={busy || !connected}
        onChange={({ value }) => {
          if (value === 'claude' || value === 'codex') {
            save({ next: { harness: value } })
          }
        }}
      />
      {(['model', 'effort', 'mode'] as const).map(field => {
        const choices = controls?.controls.find(c => c.setting === field)?.options ?? []
        const value = agent[field] ?? ''
        const options = [{ value: '', label: field === 'mode' ? 'Permissions' : field[0].toUpperCase() + field.slice(1) }, ...choices.map(o => ({ value: o.value, label: o.label }))]

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
            onChange={({ value }) => save({ next: { ...agent, [field]: value || undefined } })}
          />
        )
      })}
      <PickerField
        label="Fast"
        value={agent.fast === undefined ? 'default' : agent.fast ? 'on' : 'off'}
        options={[{ value: 'default', label: 'Fast default' }, { value: 'off', label: 'Fast off' }, { value: 'on', label: 'Fast on' }]}
        disabled={busy || !connected}
        onChange={({ value }) => save({ next: { ...agent, fast: value === 'default' ? undefined : value === 'on' } })}
      />
    </div>
  )
}
