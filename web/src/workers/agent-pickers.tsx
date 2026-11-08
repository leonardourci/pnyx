import { useEffect, useRef, useState } from 'react'
import { accountLabel } from '#workers/account-choice.ts'
import { providerIdOf } from '#workers/providers.ts'
import type { AgentConfig } from '#workers/model.ts'
import { harnessControls } from '#workers/controls.ts'
import type { Command } from '#web-app/connection.ts'
import { Button, type Option } from '#web-shared/ui/controls.tsx'
import { hasIcon, Icon } from '#web-shared/ui/icon.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { PickerField, useModels, type CellMark } from './agent-picker.tsx'
import { modelOptions } from './model-options.ts'
import { AccountModelPicker, type Selection } from './account-model-picker.tsx'
import { AgentSettingsMenu, useFolded, type FastSetting, type SettingChoice } from './agent-settings-menu.tsx'
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
  disabled = false,
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
  lastUsed,
  foldable = false,
}: {
  agent: AgentConfig
  lastUsed?: AgentConfig
  // Values the agent falls back to when it names none, such as its rule's.
  inherited?: Partial<AgentConfig>
  command: Command
  connected: boolean
  // Locks the pickers while still reading the catalogs, so the model keeps its display name.
  disabled?: boolean
  // Whether to read the harness catalogs; a Firstmate Hydra has none.
  load?: boolean
  label: string
  onChange({ next }: { next: AgentConfig }): void | Promise<unknown>
  // The agent with every value the pickers show filled in, once the catalog names them.
  onResolved?({ next }: { next: AgentConfig }): void
  // What a model's pin does: save it as Hydra's default, only select it because these pickers already edit that default, or show no pin.
  defaultAction?: 'save' | 'edit' | 'none'
  // The pickers shown beside the model; the routine helper has no permissions.
  fields?: readonly (typeof ALL_FIELDS)[number][]
  // Set when each picker is a cell of a table, such as Settings' heads dispatch rules.
  marks?: Partial<Record<'model' | 'effort' | 'mode' | 'fast', CellMark>>
  describedBy?: string
  selectionLabel?: string
  // What Fast reaches beyond this agent, added to its tooltip.
  fastNote?: string
  // Folds into one settings button when the row is too narrow for every picker, as in the composer.
  foldable?: boolean
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
    if (ready && !disabled && reported.current !== key) {
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
  const locked = !connected || disabled
  const selection: Selection | undefined = effective && {
    lastUsed,
    agent: {
      ...agent,
      model: picker.value,
    },
    account,
    effective,
    command,
    connected,
    change,
    defaultAgent,
    saveDefault: defaultAction === 'none' ? undefined : saveDefault,
  }
  const accountName = account && effective ? accountLabel({
    name: account,
    account: effective.accounts[account],
  }) : 'No account'
  const choices: SettingChoice[] = ([
    'effort',
    'mode',
  ] as const).filter(field => fields.includes(field)).map(field => {
    const value = named[field]
    const listed = controls?.controls.find(c => c.setting === field)?.options ?? []
    const options: Option[] = listed.map(o => ({
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

    return {
      field,
      title: field === 'mode' ? 'Mode' : 'Effort',
      value: value ?? '',
      options,
      // The picker keeps its place, disabled, until the catalog names the harness default.
      disabled: locked || !catalog.models,
      choose: ({ value }: { value: string }) => change({
        next: {
          ...agent,
          [field]: value,
        },
      }),
    }
  })
  const toggleFast = () => change({
    next: {
      ...agent,
      fast: !agent.fast,
    },
  })
  const fast: FastSetting | undefined = fastShown ? {
    on: agent.fast === true,
    disabled: locked,
    toggle: toggleFast,
  } : undefined
  const room = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const folded = useFolded({
    room,
    row,
  }) && foldable && !!selection
  const status = !effective && <small role="status">{dispatchError ?? 'Loading accounts…'}</small>
  const alert = saveError && <small role="alert">{saveError}</small>

  const pickers = (
    <>
      {selection ? (
        <div className="picker-field" data-changed={marks?.model?.changed || undefined} data-invalid={marks?.model?.invalid || undefined}>
          <AccountModelPicker
            {...selection}
            label={selectionLabel}
            modelLabel={modelLabel}
            disabled={locked}
            invalid={marks?.model?.invalid}
            describedBy={describedBy}
          />
        </div>
      ) : status}
      {!foldable && alert}
      {choices.map(choice => (
        <PickerField
          key={choice.field}
          iconSize={COMPOSER_ICON}
          label={choice.field === 'mode' ? 'Permissions' : 'Effort'}
          value={choice.value}
          options={choice.options}
          disabled={choice.disabled}
          mark={marks?.[choice.field]}
          onChange={choice.choose}
        />
      ))}
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
            disabled={locked}
            onClick={toggleFast}
          >
            <Icon name={agent.fast ? 'fast-on' : 'fast'} size={COMPOSER_ICON} />
          </Button>
        </Tooltip>
      )}
    </>
  )

  if (!foldable) {
    return <div className="hydra-agent-pickers" aria-label={label}>{pickers}</div>
  }

  // The full row stays laid out but hidden while folded, so its width says when it fits again.
  return (
    <div
      className="hydra-agent-pickers"
      aria-label={label}
      ref={room}
      data-folded={folded || undefined}
    >
      <div className="agent-pickers-row" ref={row} inert={folded}>{pickers}</div>
      {folded && selection && (
        <AgentSettingsMenu
          label={label}
          selection={selection}
          modelLabel={modelLabel}
          accountName={accountName}
          choices={choices}
          fast={fast}
          disabled={locked}
          iconSize={COMPOSER_ICON}
        />
      )}
      {alert}
    </div>
  )
}
