import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentConfig } from '#workers/model.ts'
import type { EffectiveDispatch, Harness } from '#workers/dispatch-config.ts'
import { accountLabel } from '#workers/account-choice.ts'
import type { Command } from '#web-app/connection.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Popover } from '#web-shared/ui/popover.tsx'
import { SearchBar } from '#web-shared/ui/search-bar.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { MenuOption } from '#web-shared/ui/menu-option.tsx'
import { useModels } from './agent-picker.tsx'
import { modelOptions } from './model-options.ts'

export const PROVIDERS = [
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

export const ACCOUNT_SETTINGS = 'pnyx-account-settings'
const HOLD_MS = 500

interface Choice {
  value: string
  label: string
  icon?: string
}

interface Selection {
  agent: AgentConfig
  account?: string
  effective: EffectiveDispatch
  command: Command
  connected: boolean
  change({ next }: { next: AgentConfig }): void
  defaultAgent?: AgentConfig
  saveDefault?({ next }: { next: AgentConfig }): void
}

function SelectionMenu({
  agent,
  account,
  effective,
  command,
  connected,
  change,
  defaultAgent,
  saveDefault,
  close,
}: Selection & { close(): void }) {
  const [
    step,
    setStep,
  ] = useState<'provider' | 'account' | 'model'>('provider')
  const [
    harness,
    setHarness,
  ] = useState<Harness>(agent.harness)
  const [
    selectedAccount,
    setAccount,
  ] = useState(account)
  const [
    query,
    setQuery,
  ] = useState('')
  const [
    active,
    setActive,
  ] = useState(0)
  const search = useRef<HTMLInputElement>(null)
  const hold = useRef<{
    timer?: ReturnType<typeof setTimeout>
    done: boolean
  }>({ done: false })
  const id = useId()
  const catalog = useModels({
    harness,
    account: selectedAccount,
    folder: selectedAccount ? effective.accounts[selectedAccount]?.folder : undefined,
    command,
    connected: connected && step === 'model',
  })
  const provider = PROVIDERS.find(item => item.harness === harness)!
  let choices: Choice[]

  if (step === 'provider') {
    choices = PROVIDERS.filter(item => Object.values(effective.accounts)
      .some(login => login.provider === item.harness))
      .map(item => ({
        value: item.harness,
        label: item.label,
        icon: item.icon,
      }))
  } else if (step === 'account') {
    choices = Object.entries(effective.accounts).filter(([
      , login,
    ]) => login.provider === harness)
      .map(([
        name,
        login,
      ]) => ({
        value: name,
        label: accountLabel({
          name,
          account: login,
        }),
        icon: provider.icon,
      }))
  } else {
    choices = modelOptions({
      models: catalog.models ?? [],
      selected: undefined,
    }).options
  }

  const filterText = query.trim().toLowerCase()
  const filtered = choices.filter(item => item.label.toLowerCase().includes(filterText))
  const stepName = {
    provider: 'providers',
    account: 'accounts',
    model: 'models',
  }[step]
  const title = {
    provider: 'Providers',
    account: `${provider.label} accounts`,
    model: 'Models',
  }[step]
  const loading = step === 'model' && !catalog.models && !catalog.error
  const error = step === 'model' ? catalog.error : ''
  const savedModel = modelOptions({
    models: catalog.models ?? [],
    selected: defaultAgent?.model,
  }).value
  const onModels = step === 'model'
  const onAgentAccount = onModels && harness === agent.harness && selectedAccount === account
  const onDefaultAccount = onModels && harness === defaultAgent?.harness
    && selectedAccount === defaultAgent.account
  const backTo = step === 'model' ? 'account' : 'provider'
  const addLabel = step === 'provider' ? 'Add provider in Settings' : 'Add account in Settings'

  useEffect(
    () => {
      search.current?.focus()
    },
    [step],
  )

  useEffect(
    () => {
      document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' })
    },
    [
      id,
      active,
      query,
      step,
    ],
  )

  useEffect(
    () => () => clearTimeout(hold.current.timer),
    [],
  )

  const navigate = ({ next }: { next: typeof step }) => {
    setQuery('')
    setActive(0)
    setStep(next)
  }

  const choose = ({
    choice,
    pin = false,
  }: {
    choice: Choice
    pin?: boolean
  }) => {
    if (!connected) {
      return
    }

    if (step === 'provider') {
      setHarness(choice.value as Harness)
      setAccount(undefined)
      navigate({ next: 'account' })

      return
    }

    if (step === 'account') {
      setAccount(choice.value)
      navigate({ next: 'model' })

      return
    }

    const sameAccount = harness === agent.harness && selectedAccount === account
    const next: AgentConfig = {
      harness,
      account: selectedAccount,
      model: choice.value,
    }

    if (sameAccount) {
      Object.assign(
        next,
        agent,
        {
          account: selectedAccount,
          model: choice.value,
        },
      )
    }

    change({ next })

    if (pin) {
      saveDefault?.({ next })
    }

    close()
  }

  const keyboard = ({ event }: { event: KeyboardEvent<HTMLDivElement> }) => {
    if (event.nativeEvent.isComposing) {
      return
    }

    const fromSearch = event.target === search.current

    if ([
      'ArrowDown',
      'ArrowUp',
      'Home',
      'End',
    ].includes(event.key) && fromSearch) {
      event.preventDefault()
      const last = Math.max(
        0,
        filtered.length - 1,
      )
      const next = {
        Home: 0,
        End: last,
        ArrowDown: active + 1,
        ArrowUp: active - 1,
      }[event.key]!
      setActive(Math.max(
        0,
        Math.min(
          last,
          next,
        ),
      ))
    } else if (event.key === 'Enter' && fromSearch && filtered[active]) {
      event.preventDefault()
      choose({
        choice: filtered[active],
        pin: !!saveDefault && (event.metaKey || event.ctrlKey),
      })
    }
  }

  const add = () => {
    close()
    window.dispatchEvent(new CustomEvent(
      ACCOUNT_SETTINGS,
      { detail: { harness: step === 'provider' ? undefined : harness } },
    ))
  }

  return (
    <div className="account-model-menu" onKeyDown={event => keyboard({ event })}>
      <div className="account-model-head">
        {step !== 'provider' && (
          <Button aria-label="Back" onClick={() => navigate({ next: backTo })}>
            <Icon name="arrow_left" size={16} />
          </Button>
        )}
        <strong>{title}</strong>
      </div>
      <SearchBar
        label={`Search ${stepName}`}
        query={query}
        inputRef={search}
        setQuery={({ query }) => {
          setQuery(query); setActive(0)
        }}
        placeholder={`Search ${stepName}…`}
        combobox={{
          expanded: true,
          controls: id,
          activeDescendant: filtered[active] ? `${id}-${active}` : undefined,
        }}
      />
      <div
        className="account-model-results"
        role="listbox"
        id={id}
        aria-label={title}
      >
        {loading && <p role="status">Loading models…</p>}
        {error && (
          <div role="alert">
            <p>{error}</p>
            <Button onClick={catalog.retry}>Retry models</Button>
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <p role="status">{query ? 'No matches.' : 'No options available.'}</p>
        )}
        {filtered.map((
          choice,
          index,
        ) => {
          const current = onAgentAccount && choice.value === agent.model
          const pinned = onDefaultAccount && choice.value === savedModel
          const defaultText = pinned
            ? 'Default for new sessions'
            : 'Set as default for new sessions'
          const mark = onModels
            ? current && <Icon name="check" size={16} />
            : <Icon name="chevron_right" size={16} />

          return (
            <MenuOption
              className="account-model-option"
              aria-label={choice.label}
              selected={current}
              active={active === index}
              disabled={!connected}
              id={`${id}-${index}`}
              key={choice.value}
              onPointerMove={() => setActive(index)}
              onFocus={() => setActive(index)}
            >
              <Button
                className="account-model-choose"
                disabled={!connected}
                onPointerDown={event => {
                  hold.current.done = false
                  clearTimeout(hold.current.timer)

                  if (step === 'model' && saveDefault && event.pointerType !== 'mouse') {
                    hold.current.timer = setTimeout(
                      () => {
                        hold.current.done = true
                        choose({
                          choice,
                          pin: true,
                        })
                      },
                      HOLD_MS,
                    )
                  }
                }}
                onPointerUp={() => clearTimeout(hold.current.timer)}
                onPointerCancel={() => clearTimeout(hold.current.timer)}
                onClick={event => {
                  if (!hold.current.done) {
                    choose({
                      choice,
                      pin: step === 'model' && !!saveDefault && (event.metaKey || event.ctrlKey),
                    })
                  }
                }}
              >
                {choice.icon && <Icon name={choice.icon} size={18} />}
                <span>{choice.label}</span>
                {mark}
              </Button>
              {step === 'model' && saveDefault && (
                <Tooltip content={defaultText}>
                  <Button
                    className="account-model-pin"
                    disabled={!connected}
                    aria-label={`${defaultText}: ${choice.label}`}
                    aria-pressed={pinned}
                    onClick={() => choose({
                      choice,
                      pin: true,
                    })}
                  ><Icon name={pinned ? 'pinned' : 'pin'} size={16} />
                  </Button>
                </Tooltip>
              )}
            </MenuOption>
          )
        })}
      </div>
      {step !== 'model' && (
        <div className="account-model-add">
          <Button variant="surface" onClick={add}><Icon name="plus" size={16} />{addLabel}</Button>
          <p>Or ask Hydra to add it for you.</p>
        </div>
      )}
    </div>
  )
}

export function AccountModelPicker({
  label,
  modelLabel,
  disabled,
  trigger,
  invalid,
  describedBy,
  ...selection
}: Selection & {
  label: string
  modelLabel: string
  disabled?: boolean
  trigger?: ReactNode
  invalid?: boolean
  describedBy?: string
}) {
  const provider = PROVIDERS.find(item => item.harness === selection.agent.harness)!
  const name = selection.account ? accountLabel({
    name: selection.account,
    account: selection.effective.accounts[selection.account],
  }) : 'No account'
  const accessible = trigger ? label : `${label}: ${provider.label} · ${name} · ${modelLabel}`

  return (
    <Popover
      label={accessible}
      className="account-model-picker"
      disabled={disabled}
      invalid={invalid}
      describedBy={describedBy}
      trigger={trigger ?? (
        <>
          <Icon name={provider.icon} size={20} />
          <span className="account-model-label">
            <span>{modelLabel}</span>
            <small>{name}</small>
          </span>
          <Icon name="chevron_down" size={14} />
        </>
      )}
    >
      {({ close }) => <SelectionMenu {...selection} close={close} />}
    </Popover>
  )
}
