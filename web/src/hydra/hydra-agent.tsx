import { useHeadsDispatch } from './heads-dispatch.ts'
import { useState } from 'react'
import type { HydraState } from '../../../src/core/model.ts'
import { harnessControls } from '../../../src/core/control.ts'
import { Button, Select } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

export function HydraAgent({ state, command, connected, notify }: {
  state: HydraState
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const { effective } = useHeadsDispatch({ command, seq: state.seq })
  const agent = effective?.dispatch.rules.hydra?.candidates[0] ?? { harness: 'claude' }
  const [busy, setBusy] = useState(false)
  const controls = harnessControls({ provider: agent.harness === 'claude' ? 'claude-code' : 'codex', hosted: true })

  const save = ({ args }: { args: string[] }) => {
    setBusy(true)
    void command({ name: 'rule', args: ['set', 'hydra', ...args, '--event-id', crypto.randomUUID()] })
      .then(() => notify({ text: 'Hydra agent saved for its next start.' }), (error: Error) => notify({ text: error.message }))
      .finally(() => setBusy(false))
  }

  return (
    <div className="composer-settings" role="group" aria-label="Hydra agent for next start">
      <Select
        label="Hydra harness"
        value={agent.harness}
        options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]}
        disabled={!connected || busy}
        onChange={({ value }) => save({ args: ['--harness', value, '--model', '', '--effort', '', '--mode', '', '--fast', 'default'] })}
      />
      {(['model', 'effort'] as const).map(field => {
        const choices = controls?.controls.find(c => c.setting === field)?.options ?? []
        const value = agent[field] ?? ''
        const options = [{ value: '', label: field === 'model' ? 'Default model' : 'Default effort' }, ...choices.map(o => ({ value: o.value, label: o.label }))]

        if (value && !options.some(o => o.value === value)) {
          options.push({ value, label: value })
        }

        return (
          <Select
            key={field}
            label={`Hydra ${field}`}
            value={value}
            options={options}
            disabled={!connected || busy}
            onChange={({ value }) => save({ args: [`--${field}`, value ] })}
          />
        )
      })}
      <Button
        className="fast-toggle"
        role="switch"
        aria-label="Hydra Fast"
        aria-checked={agent.fast === true}
        disabled={!connected || busy}
        title="Fast for Hydra’s next start"
        onClick={() => save({ args: ['--fast', agent.fast ? 'off' : 'on'] })}
      >Fast
      </Button>
    </div>
  )
}
