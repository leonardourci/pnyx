import { useEffect, useRef } from 'react'
import type { AgentConfig } from '#workers/model.ts'
import { harnessControls } from '#workers/controls.ts'
import type { Command } from '#web-app/connection.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { hasIcon, Icon } from '#web-shared/ui/icon.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { ModelPicker, PickerField, useModels } from './agent-picker.tsx'
import { modelOptions } from './model-options.ts'

// The composer's control icons, one size so they read alike.
export const COMPOSER_ICON = 18

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

export interface PickerDefault {
  defaultValue?: string
  onDefault?({
    value,
    harness,
  }: {
    value: string
    harness?: AgentConfig['harness']
  }): void
}

// The composer's model, effort, permission and Fast pickers for one agent; Hydra's composer and Settings both draw these.
export function AgentPickers({
  agent,
  inherited,
  command,
  connected,
  load = true,
  label,
  onChange,
  onResolved,
  startsWith,
}: {
  agent: AgentConfig
  // Values the agent falls back to when it names none, such as its rule's.
  inherited?: Partial<AgentConfig>
  command: Command
  connected: boolean
  // Whether to read the harness catalogs; a Firstmate Hydra has none.
  load?: boolean
  label: string
  onChange({ next }: { next: AgentConfig }): void
  // The agent with every value the pickers show filled in, once the catalog names them.
  onResolved?({ next }: { next: AgentConfig }): void
  startsWith?({ field }: { field: 'model' | 'effort' | 'mode' }): PickerDefault
}) {
  const controls = harnessControls({
    provider: agent.harness === 'claude' ? 'claude-code' : 'codex',
    hosted: true,
  })
  // Both catalogs load, so the one picker can switch agent and model together.
  const catalogs = {
    claude: useModels({
      harness: 'claude',
      command,
      connected: connected && load,
    }),
    codex: useModels({
      harness: 'codex',
      command,
      connected: connected && load,
    }),
  }
  const catalog = catalogs[agent.harness]
  const picker = modelOptions({
    models: catalog.models ?? [],
    selected: agent.model ?? inherited?.model,
  })
  // A model the catalog does not list still runs with the harness's defaults.
  const defaults = catalog.models?.find(option => option.value === picker.value)
    ?? catalog.models?.find(option => option.isDefault || option.value === 'default') ?? catalog.models?.[0]
  const named = {
    model: agent.model && agent.model !== 'default' ? agent.model : picker.value,
    effort: agent.effort ?? inherited?.effort ?? defaults?.defaultEffort,
    mode: agent.mode ?? inherited?.mode ?? defaults?.defaultMode,
  }
  const resolved: AgentConfig = {
    ...agent,
    // Fast mode starts off; only the toggle turns it on.
    fast: agent.fast ?? false,
  }

  for (const field of [
    'model',
    'effort',
    'mode',
  ] as const) {
    if (named[field]) {
      resolved[field] = named[field]
    }
  }

  const ready = !!catalog.models
  const key = JSON.stringify(resolved)
  const reported = useRef('')

  useEffect(() => {
    if (ready && reported.current !== key) {
      reported.current = key
      onResolved?.({ next: resolved })
    }
  })

  const modelDefault = startsWith?.({ field: 'model' })

  return (
    <div className="hydra-agent-pickers" aria-label={label}>
      <ModelPicker
        {...catalog}
        iconSize={COMPOSER_ICON}
        value={picker.value && `${agent.harness}:${picker.value}`}
        options={HARNESSES.flatMap(({
          harness,
          label: group,
          icon,
        }) => (harness === agent.harness ? picker
          : modelOptions({ models: catalogs[harness].models ?? [] })).options
          .map(option => ({
            value: `${harness}:${option.value}`,
            label: option.label,
            icon,
            group,
          })))}
        disabled={!connected}
        connected={connected}
        onChange={({ value }) => {
          const [
            harness,
            model,
          ] = splitChoice({ value })

          onChange({
            next: harness === agent.harness ? {
              ...agent,
              model,
            } : {
              harness,
              model,
            },
          })
        }}
        defaultValue={modelDefault?.defaultValue}
        onDefault={modelDefault?.onDefault && (({ value }) => {
          const [
            harness,
            model,
          ] = splitChoice({ value })
          modelDefault.onDefault?.({
            value: model,
            harness,
          })
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
            iconSize={COMPOSER_ICON}
            label={field === 'mode' ? 'Permissions' : 'Effort'}
            value={value ?? ''}
            options={options}
            disabled={!connected || !catalog.models}
            onChange={({ value }) => onChange({
              next: {
                ...agent,
                [field]: value,
              },
            })}
            {...startsWith?.({ field })}
          />
        )
      })}
      <Tooltip content={agent.fast ? 'Fast mode on' : 'Fast mode off'}>
        <Button
          className="fast-toggle"
          aria-label="Fast mode"
          aria-pressed={agent.fast === true}
          disabled={!connected}
          onClick={() => onChange({
            next: {
              ...agent,
              fast: !agent.fast,
            },
          })}
        >
          <Icon name={agent.fast ? 'fast-on' : 'fast'} size={COMPOSER_ICON} />
        </Button>
      </Tooltip>
    </div>
  )
}
