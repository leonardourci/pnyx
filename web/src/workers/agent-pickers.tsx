import { useRef, useState } from 'react'
import { providerIdOf } from '#workers/providers.ts'
import type { AgentConfig } from '#workers/model.ts'
import { harnessControls } from '#workers/controls.ts'
import type { Command } from '#web-app/connection.ts'
import { Button, type Option } from '#web-shared/ui/controls.tsx'
import { ICON_SIZE, hasIcon, Icon } from '#web-shared/icons.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { PickerField, PickerShell, useModels, type CellMark } from './agent-picker.tsx'
import { modelOptions } from './model-options.ts'
import { AccountModelPicker, type Selection } from './account-model-picker.tsx'
import { AgentSettingsMenu, useFolded, type FastSetting, type SettingChoice } from './agent-settings-menu.tsx'
import { hydraDefault, resolvedAccount, useHeadsDispatch } from './heads-dispatch.ts'

const PICKERS_CLASS = 'hydra-agent-pickers flex min-w-0 flex-1 flex-wrap items-center gap-0.5 in-[.settings-page]:gap-(--settings-column-gap) data-folded:relative in-[.settings-page]:[&_.fast-toggle]:w-(--agent-control-h) [&_.picker-field]:block [&_.picker-field]:min-w-0 [&_.picker-field]:text-meta [&_.picker-field>span]:hidden [&_.select]:min-w-0 [&_.select-menu]:absolute [&_.select-menu]:top-auto [&_.select-menu]:bottom-control-menu [&_.select>.button]:min-h-6.5 [&_.select>.button]:gap-0.75 [&_.select>.button]:border-0 [&_.select>.button]:bg-transparent [&_.select>.button]:px-1.25 [&_.select>.button]:py-0.5 [&_.select>.button]:text-meta [&_.select>.button]:text-muted [&_.select>.button>svg:not(:last-child)]:text-ink in-[.settings-page]:[&_:is(.select>.button,.account-model-picker>.button,.fast-toggle)]:min-h-(--agent-control-h) in-[.settings-page]:[&_:is(.select>.button,.account-model-picker>.button,.fast-toggle)]:text-ui [&_:is(.select>.button,.account-model-picker>.button,.fast-toggle):is(:hover,:focus-visible):not(:disabled)]:bg-hover [&[data-folded]>.agent-pickers-row]:pointer-events-none [&[data-folded]>.agent-pickers-row]:invisible [&[data-folded]>.agent-pickers-row]:absolute'

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
  const choices: SettingChoice[] = ([
    'effort',
    'mode',
  ] as const).filter(field => fields.includes(field)).map(field => {
    const value = named[field]
    const listed = controls?.controls.find(c => c.setting === field)?.options ?? []
    const options = listed.map(o => {
      const option: Option = {
        value: o.value,
        label: o.label,
      }
      const icon = `${field}-${o.value}`

      if (hasIcon({ name: icon })) {
        option.icon = icon
      }

      return option
    })

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
    note: fastNote,
    toggle: toggleFast,
  } : undefined
  const room = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const folded = useFolded({
    room,
    row,
  }) && foldable && !!selection
  const alert = saveError && <small role="alert">{saveError}</small>

  const pickers = (
    <>
      {selection ? (
        <PickerShell
          data-changed={marks?.model?.changed || undefined}
          data-invalid={marks?.model?.invalid || undefined}
        >
          <AccountModelPicker
            {...selection}
            label={selectionLabel}
            modelLabel={modelLabel}
            disabled={locked}
            invalid={marks?.model?.invalid}
            describedBy={describedBy}
          />
        </PickerShell>
      ) : <small role="status">{dispatchError ?? 'Loading accounts…'}</small>}
      {!foldable && alert}
      {choices.map(choice => (
        <PickerField
          key={choice.field}
          iconSize={ICON_SIZE.toolbar}
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
          <span className="fast-unavailable inline-flex min-h-(--agent-control-h) w-(--agent-control-h) cursor-default items-center justify-center text-muted opacity-60" tabIndex={0} aria-label="Fast isn't available for this model">–</span>
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
            className="fast-toggle min-h-6.5 px-1.5 py-0.5 text-meta text-muted aria-pressed:text-gold"
            data-changed={marks?.fast?.changed || undefined}
            aria-label="Fast mode"
            aria-pressed={agent.fast === true}
            disabled={locked}
            onClick={toggleFast}
          >
            <Icon name={agent.fast ? 'fast-on' : 'fast'} size={ICON_SIZE.toolbar} />
          </Button>
        </Tooltip>
      )}
    </>
  )

  if (!foldable) {
    return <div className={PICKERS_CLASS} aria-label={label}>{pickers}</div>
  }

  // The full row stays laid out but hidden while folded, so its width says when it fits again.
  return (
    <div
      className={PICKERS_CLASS}
      aria-label={label}
      ref={room}
      data-folded={folded || undefined}
    >
      <div className="agent-pickers-row flex w-max flex-none items-center gap-inherit" ref={row} inert={folded}>{pickers}</div>
      {folded && selection && (
        <AgentSettingsMenu
          label={label}
          selection={selection}
          modelLabel={modelLabel}
          choices={choices}
          fast={fast}
          disabled={locked}
          iconSize={ICON_SIZE.toolbar}
        />
      )}
      {alert}
    </div>
  )
}
