import { hydraDefault, useHeadsDispatch } from './heads-dispatch.ts'
import { useEffect, useRef } from 'react'
import type { AgentConfig, HydraState } from '../../../src/core/model.ts'
import { harnessControls } from '../../../src/core/control.ts'
import { ModelPicker, PickerField, useModels } from './agent-picker.tsx'
import { Button } from '../components/ui/controls.tsx'
import { hasIcon, Icon } from '../components/ui/icon.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { modelOptions } from './model-options.ts'
import type { Command } from './connection.ts'

const HARNESSES = [
  {
    harness: 'claude',
    label: 'Claude Code',
    icon: 'claude-code',
  },
  {
    harness: 'codex',
    label: 'Codex',
    icon: 'codex',
  },
] as const

// A combined choice is the agent and its model, as harness:model.
const splitChoice = ({ value }: { value: string }) => {
  const at = value.indexOf(':')

  return [
    value.slice(
      0,
      at,
    ) as AgentConfig['harness'],
    value.slice(at + 1),
  ] as const
}

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
  const {
    effective,
    saveHydra,
  } = useHeadsDispatch({ command })
  const rule = effective?.dispatch.rules.hydra?.candidates[0] ?? effective?.dispatch.default[0]
  const agent: AgentConfig = state.config?.hydra.agent ?? rule ?? { harness: 'claude' }
  const inherited = rule?.harness === agent.harness ? rule : undefined
  const controls = harnessControls({
    provider: agent.harness === 'claude' ? 'claude-code' : 'codex',
    hosted: true,
  })
  const firstmate = state.config?.hydra.kind === 'firstmate'
  // Both catalogs load, so the one picker can switch agent and model together.
  const catalogs = {
    claude: useModels({
      harness: 'claude',
      command,
      connected: connected && !firstmate,
    }),
    codex: useModels({
      harness: 'codex',
      command,
      connected: connected && !firstmate,
    }),
  }
  const catalog = catalogs[agent.harness]
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
    void command({
      name: 'hydra-agent',
      args: [JSON.stringify(next)],
    })
      .catch((error: Error) => notify({ text: error.message }))
  }

  // Saving the named values makes Hydra run with exactly what the pickers show.
  const next: AgentConfig = {
    ...agent,
    ...(named.model ? { model: named.model } : {}),
    ...(named.effort ? { effort: named.effort } : {}),
    ...(named.mode ? { mode: named.mode } : {}),
    // Fast mode starts off; only the toggle turns it on.
    fast: agent.fast ?? false,
  }
  const fields = [
    'model',
    'effort',
    'mode',
    'fast',
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

  // The hydra rule is what every new Hydra starts with.
  const startsWith = ({ field }: { field: 'model' | 'effort' | 'mode' }) => ({
    defaultValue: rule?.harness !== agent.harness ? undefined : rule[field],
    onDefault: ({
      value,
      harness = agent.harness,
    }: {
      value: string
      harness?: AgentConfig['harness']
    }) => void saveHydra({
      patch: hydraDefault({
        rule,
        harness,
        field,
        value,
      }),
    }).then(
      () => notify({ text: 'New Hydras will start with this.' }),
      (error: Error) => notify({ text: error.message }),
    ),
  })

  return (
    <div className="hydra-agent-pickers" aria-label="Hydra agent settings">
      <ModelPicker
        {...catalog}
        value={picker.value && `${agent.harness}:${picker.value}`}
        options={HARNESSES.flatMap(({
          harness,
          label,
          icon,
        }) => (harness === agent.harness ? picker
          : modelOptions({ models: catalogs[harness].models ?? [] })).options
          .map(option => ({
            value: `${harness}:${option.value}`,
            label: option.label,
            icon,
            group: label,
          })))}
        disabled={!connected}
        connected={connected}
        onChange={({ value }) => {
          const [
            harness,
            model,
          ] = splitChoice({ value })

          save({
            next: harness === agent.harness ? {
              ...agent,
              model,
            } : {
              harness,
              model,
            },
          })
        }}
        defaultValue={rule?.model ? `${rule.harness}:${rule.model}` : undefined}
        onDefault={({ value }) => {
          const [
            harness,
            model,
          ] = splitChoice({ value })
          startsWith({ field: 'model' }).onDefault({
            value: model,
            harness,
          })
        }}
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
          ...(hasIcon({ name: `${field}-${o.value}` }) ? { icon: `${field}-${o.value}` } : {}),
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
            disabled={!connected || !catalog.models}
            onChange={({ value }) => save({
              next: {
                ...agent,
                [field]: value,
              },
            })}
            {...startsWith({ field })}
          />
        )
      })}
      <Tooltip content={agent.fast ? 'Fast mode on' : 'Fast mode off'}>
        <Button
          className="fast-toggle"
          aria-label="Fast mode"
          aria-pressed={agent.fast === true}
          disabled={!connected}
          onClick={() => save({
            next: {
              ...agent,
              fast: !agent.fast,
            },
          })}
        >
          <Icon name={agent.fast ? 'fast-on' : 'fast'} size={15} />
        </Button>
      </Tooltip>
    </div>
  )
}
