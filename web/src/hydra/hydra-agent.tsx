import { useHeadsDispatch } from './heads-dispatch.ts'
import { useEffect, useRef, useState } from 'react'
import type { AgentConfig, HydraState } from '../../../src/core/model.ts'
import { harnessControls } from '../../../src/core/control.ts'
import { ModelPicker, PickerField, useModels } from './agent-picker.tsx'
import { modelOptions } from './model-options.ts'
import type { Command } from './connection.ts'

export function HydraAgent({
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
  const { effective } = useHeadsDispatch({ command })
  const [
    busy,
    setBusy,
  ] = useState(false)
  const rule = effective?.dispatch.rules.hydra?.candidates[0] ?? effective?.dispatch.default[0]
  const agent: AgentConfig = state.config?.hydra.agent ?? rule ?? { harness: 'claude' }
  const inherited = rule?.harness === agent.harness ? rule : undefined
  const controls = harnessControls({
    provider: agent.harness === 'claude' ? 'claude-code' : 'codex',
    hosted: true,
  })
  const firstmate = state.config?.hydra.kind === 'firstmate'
  const catalog = useModels({
    harness: agent.harness,
    command,
    connected: connected && !firstmate,
  })
  const selected = agent.model ?? inherited?.model
  const picker = modelOptions({
    models: catalog.models ?? [],
    selected,
  })
  // A model the catalog does not list still runs with the harness's defaults.
  const defaults = catalog.models?.find(option => option.value === picker.value)
    ?? catalog.models?.find(option => option.isDefault || option.value === 'default') ?? catalog.models?.[0]
  const named = {
    model: agent.model && agent.model !== 'default' ? agent.model : picker.value,
    effort: agent.effort ?? inherited?.effort ?? defaults?.defaultEffort,
    mode: agent.mode ?? inherited?.mode ?? defaults?.defaultMode,
  }
  const resolved = useRef('')

  const save = ({ next }: { next: AgentConfig }) => {
    setBusy(true)
    void command({
      name: 'hydra-agent',
      args: [JSON.stringify(next)],
    })
      .catch((error: Error) => notify({ text: error.message }))
      .finally(() => setBusy(false))
  }

  // Saving the named values makes Hydra run with exactly what the pickers show.
  const next: AgentConfig = {
    ...agent,
    ...(named.model ? { model: named.model } : {}),
    ...(named.effort ? { effort: named.effort } : {}),
    ...(named.mode ? { mode: named.mode } : {}),
  }
  const fields = [
    'model',
    'effort',
    'mode',
  ] as const
  const missing = !firstmate && !!effective && !!catalog.models
    && fields.some(field => next[field] !== agent[field])
  const key = JSON.stringify(next)

  useEffect(() => {
    if (missing && resolved.current !== key) {
      resolved.current = key
      save({ next })
    }
  })

  if (firstmate) {
    return null
  }

  return (
    <div className="hydra-agent-pickers" aria-label="Hydra agent settings">
      <PickerField
        label="Harness"
        value={agent.harness}
        options={[
          {
            value: 'claude',
            label: 'Claude Code',
          },
          {
            value: 'codex',
            label: 'Codex',
          },
        ]}
        disabled={busy || !connected}
        onChange={({ value }) => {
          if (value === 'claude' || value === 'codex') {
            save({ next: { harness: value } })
          }
        }}
      />
      <ModelPicker
        {...catalog}
        value={picker.value}
        options={picker.options}
        disabled={busy || !connected}
        connected={connected}
        onChange={({ value }) => save({
          next: {
            ...agent,
            model: value,
          },
        })}
      />
      {([
        'effort',
        'mode',
      ] as const).map(field => {
        const value = named[field]
        const choices = controls?.controls.find(c => c.setting === field)?.options ?? []
        const options = choices.map(o => ({
          value: o.value,
          label: o.label,
        }))

        if (value && !options.some(o => o.value === value)) {
          options.push({
            value,
            label: value,
          })
        }

        // The picker keeps its place, disabled, until the catalog names the harness default.
        return (
          <PickerField
            key={field}
            label={field === 'mode' ? 'Permissions' : 'Effort'}
            value={value ?? ''}
            options={options}
            disabled={busy || !connected || !catalog.models}
            onChange={({ value }) => save({
              next: {
                ...agent,
                [field]: value,
              },
            })}
          />
        )
      })}
      <PickerField
        label="Fast"
        value={agent.fast === undefined ? 'default' : agent.fast ? 'on' : 'off'}
        options={[
          {
            value: 'default',
            label: 'Fast default',
          },
          {
            value: 'off',
            label: 'Fast off',
          },
          {
            value: 'on',
            label: 'Fast on',
          },
        ]}
        disabled={busy || !connected}
        onChange={({ value }) => save({
          next: {
            ...agent,
            fast: value === 'default' ? undefined : value === 'on',
          },
        })}
      />
    </div>
  )
}
