import { useEffect, useRef, useState } from 'react'
import { providerIdOf } from '#workers/providers.ts'
import type { AgentConfig } from '#workers/model.ts'
import { harnessControls } from '#workers/controls.ts'
import type { Command } from '#web-app/connection.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { hasIcon, Icon } from '#web-shared/ui/icon.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { PickerField, useModels, type CellMark } from './agent-picker.tsx'
import { modelOptions } from './model-options.ts'
import { AccountModelPicker } from './account-model-picker.tsx'
import { hydraDefault, resolvedAccount, useHeadsDispatch } from './heads-dispatch.ts'

// The composer's control icons, one size so they read alike.
export const COMPOSER_ICON = 18

const ALL_FIELDS = [
  'effort',
  'mode',
  'fast',
] as const

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
  defaultAction = 'save',
  fields = ALL_FIELDS,
  marks,
  describedBy,
  selectionLabel = 'Model',
  fastNote,
}: {
  agent: AgentConfig
  // Values the agent falls back to when it names none, such as its rule's.
  inherited?: Partial<AgentConfig>
  command: Command
  connected: boolean
  // Whether to read the harness catalogs; a Firstmate Hydra has none.
  load?: boolean
  label: string
  onChange({ next }: { next: AgentConfig }): void | Promise<unknown>
  // The agent with every value the pickers show filled in, once the catalog names them.
  onResolved?({ next }: { next: AgentConfig }): void
  defaultAction?: 'save' | 'edit' | 'none'
  // The pickers shown beside the model; the routine helper has no permissions.
  fields?: readonly (typeof ALL_FIELDS)[number][]
  // Set when each picker is a cell of a table, such as Settings' heads dispatch rules.
  marks?: Partial<Record<'model' | 'effort' | 'mode' | 'fast', CellMark>>
  describedBy?: string
  selectionLabel?: string
  // What Fast reaches beyond this agent, added to its tooltip.
  fastNote?: string
}) {
  const controls = harnessControls({
    provider: providerIdOf({ harness: agent.harness }),
    hosted: true,
  })
  const {
    effective,
    error: dispatchError,
    saveHydra,
  } = useHeadsDispatch({ command })
  const [
    saveError,
    setSaveError,
  ] = useState('')
  const account = resolvedAccount({
    effective,
    agent: {
      harness: agent.harness,
      account: agent.account ?? inherited?.account,
    },
  })
  const catalog = useModels({
    harness: agent.harness,
    account,
    folder: account ? effective?.accounts[account]?.folder : undefined,
    command,
    connected: connected && load && !!account,
  })
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
    account,
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
  // Fast shows for a model with a Fast tier, and while it is on so it can be turned off.
  const fastShown = fields.includes('fast') && (!ready || defaults?.fast || agent.fast)
  // A table cell keeps its place with a dash instead.
  const fastDash = fields.includes('fast') && !fastShown && marks !== undefined
  const key = JSON.stringify(resolved)
  const reported = useRef('')

  useEffect(() => {
    if (ready && reported.current !== key) {
      reported.current = key
      onResolved?.({ next: resolved })
    }
  })

  const rule = effective?.dispatch.rules.hydra?.candidates[0] ?? effective?.dispatch.default[0]
  const defaultAgent = rule && effective ? {
    ...rule,
    account: resolvedAccount({
      effective,
      agent: rule,
    }),
  } : undefined

  const change = async ({ next }: { next: AgentConfig }) => {
    setSaveError('')

    try {
      await onChange({ next })
    } catch (error) {
      setSaveError((error as Error).message)
    }
  }

  const saveDefault = async ({ next }: { next: AgentConfig }) => {
    if (defaultAction === 'edit') {
      return
    }

    setSaveError('')

    try {
      await saveHydra({
        patch: hydraDefault({
          rule: defaultAgent,
          next,
        }),
      })
    } catch (error) {
      setSaveError((error as Error).message)
    }
  }

  const modelLabel = picker.options.find(option => option.value === picker.value)?.label ?? agent.model ?? 'Model'

  return (
    <div className="hydra-agent-pickers" aria-label={label}>
      {effective ? (
        <div className="picker-field" data-changed={marks?.model?.changed || undefined} data-invalid={marks?.model?.invalid || undefined}>
          <AccountModelPicker
            label={selectionLabel}
            modelLabel={modelLabel}
            agent={{
              ...agent,
              model: picker.value,
            }}
            account={account}
            effective={effective}
            command={command}
            connected={connected}
            disabled={!connected}
            invalid={marks?.model?.invalid}
            describedBy={describedBy}
            change={change}
            defaultAgent={defaultAgent}
            saveDefault={defaultAction === 'none' ? undefined : saveDefault}
          />
        </div>
      ) : <small role="status">{dispatchError ?? 'Loading accounts…'}</small>}
      {saveError && <small role="alert">{saveError}</small>}
      {([
        'effort',
        'mode',
      ] as const).filter(field => fields.includes(field)).map(field => {
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
            mark={marks?.[field]}
            onChange={({ value }) => change({
              next: {
                ...agent,
                [field]: value,
              },
            })}
          />
        )
      })}
      {fastDash && (
        <Tooltip content="Fast isn't available for this model">
          <span className="fast-unavailable" tabIndex={0} aria-label="Fast isn't available for this model">–</span>
        </Tooltip>
      )}
      {fastShown && (
        <Tooltip
          content={[
            agent.fast ? 'Fast mode on.' : 'Fast mode off.',
            fastNote,
          ].filter(Boolean).join(' ')}
        >
          <Button
            className="fast-toggle"
            data-changed={marks?.fast?.changed || undefined}
            aria-label="Fast mode"
            aria-pressed={agent.fast === true}
            disabled={!connected}
            onClick={() => change({
              next: {
                ...agent,
                fast: !agent.fast,
              },
            })}
          >
            <Icon name={agent.fast ? 'fast-on' : 'fast'} size={COMPOSER_ICON} />
          </Button>
        </Tooltip>
      )}
    </div>
  )
}
