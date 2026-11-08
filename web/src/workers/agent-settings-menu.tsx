import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Button, type Option } from '#web-shared/ui/controls.tsx'
import { hasIcon, Icon } from '#web-shared/ui/icon.tsx'
import { MenuOption } from '#web-shared/ui/menu-option.tsx'
import { Popover } from '#web-shared/ui/popover.tsx'
import { PROVIDERS, SelectionMenu, type Selection } from './account-model-picker.tsx'

const ROW_ICON = 18
const CHEVRON = 16

export interface SettingChoice {
  field: 'effort' | 'mode'
  title: string
  value: string
  options: Option[]
  disabled: boolean
  choose({ value }: { value: string }): void
}

export interface FastSetting {
  on: boolean
  disabled: boolean
  toggle(): void
}

type Step = 'settings' | 'model' | SettingChoice['field']

const optionIcon = ({
  field,
  value,
}: {
  field: SettingChoice['field']
  value: string
}) => {
  if (field === 'mode') {
    return 'mode'
  }

  const name = `effort-${value}`

  return hasIcon({ name }) ? name : 'effort'
}

const valueLabel = ({ choice }: { choice: SettingChoice }) =>
  choice.options.find(option => option.value === choice.value)?.label ?? choice.value

// Folds the composer's settings into one button once their row is wider than the room the composer leaves them.
export function useFolded({
  room,
  row,
}: {
  room: RefObject<HTMLElement | null>
  row: RefObject<HTMLElement | null>
}) {
  const [
    folded,
    setFolded,
  ] = useState(false)

  useLayoutEffect(
    () => {
      const roomElement = room.current
      const rowElement = row.current

      if (!roomElement || !rowElement) {
        return
      }

      const measure = () => setFolded(rowElement.offsetWidth > roomElement.clientWidth)
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(roomElement)
      observer.observe(rowElement)

      return () => observer.disconnect()
    },
    [
      room,
      row,
    ],
  )

  return folded
}

// Arrow keys move between a list's rows and Backspace goes up a level, as in the provider switcher.
const listKeys = ({
  event,
  back,
}: {
  event: KeyboardEvent<HTMLDivElement>
  back?(): void
}) => {
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.account-model-choose:not(:disabled)')]
  const at = rows.indexOf(document.activeElement as HTMLButtonElement)

  if (event.key === 'Backspace' && back) {
    event.preventDefault()
    back()

    return
  }

  const step = {
    ArrowDown: 1,
    ArrowUp: -1,
  }[event.key]

  if (!step || !rows.length) {
    return
  }

  event.preventDefault()
  rows[Math.max(
    0,
    Math.min(
      rows.length - 1,
      at + step,
    ),
  )]?.focus()
}

function MenuList({
  title,
  back,
  children,
}: {
  title: string
  back?(): void
  children: ReactNode
}) {
  const list = useRef<HTMLDivElement>(null)

  useEffect(
    () => {
      const current = list.current?.querySelector<HTMLButtonElement>('[aria-selected=true] > .account-model-choose:not(:disabled)')
      const first = list.current?.querySelector<HTMLButtonElement>('.account-model-choose:not(:disabled)')
      const focused = current ?? first
      focused?.focus()
    },
    [title],
  )

  return (
    <div
      className="account-model-menu"
      onKeyDown={event => listKeys({
        event,
        back,
      })}
    >
      <div className="account-model-head">
        {back && (
          <Button aria-label="Back" onClick={back}>
            <Icon name="arrow_left" size={16} />
          </Button>
        )}
        <strong>{title}</strong>
      </div>
      <div
        className="account-model-results"
        role="listbox"
        aria-label={title}
        ref={list}
      >
        {children}
      </div>
    </div>
  )
}

function SettingRow({
  icon,
  name,
  value,
  drills,
  pressed,
  disabled,
  onClick,
}: {
  icon: string
  name: string
  value: string
  drills: boolean
  pressed?: boolean
  disabled: boolean
  onClick(): void
}) {
  return (
    <MenuOption className="account-model-option" aria-label={`${name}: ${value}`} disabled={disabled}>
      <Button
        className="account-model-choose agent-setting-row"
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon name={icon} size={ROW_ICON} />
        <span className="agent-setting-text"><span>{name}</span><small>{value}</small></span>
        {drills && <Icon name="chevron_right" size={CHEVRON} />}
      </Button>
    </MenuOption>
  )
}

function ChoiceList({
  choice,
  back,
}: {
  choice: SettingChoice
  back(): void
}) {
  return (
    <MenuList title={choice.title} back={back}>
      {choice.options.map(option => {
        const current = option.value === choice.value

        return (
          <MenuOption
            className="account-model-option"
            aria-label={option.label}
            selected={current}
            disabled={choice.disabled}
            key={option.value}
          >
            <Button
              className="account-model-choose"
              disabled={choice.disabled}
              onClick={() => {
                choice.choose({ value: option.value })
                back()
              }}
            >
              {option.icon && <Icon name={option.icon} size={ROW_ICON} />}
              <span>{option.label}</span>
              {current && <Icon name="check" size={CHEVRON} />}
            </Button>
          </MenuOption>
        )
      })}
    </MenuList>
  )
}

function SettingsMenu({
  selection,
  modelLabel,
  accountName,
  choices,
  fast,
  close,
}: {
  selection: Selection
  modelLabel: string
  accountName: string
  choices: SettingChoice[]
  fast?: FastSetting
  close(): void
}) {
  const [
    step,
    setStep,
  ] = useState<Step>('settings')
  const toSettings = () => setStep('settings')
  const provider = PROVIDERS.find(item => item.harness === selection.agent.harness)!
  const open = choices.find(choice => choice.field === step)

  if (step === 'model') {
    return (
      <SelectionMenu
        {...selection}
        close={close}
        done={toSettings}
        back={toSettings}
      />
    )
  }

  if (open) {
    return <ChoiceList choice={open} back={toSettings} />
  }

  return (
    <MenuList title="Settings">
      <SettingRow
        icon={provider.icon}
        name="Model"
        value={`${modelLabel} · ${accountName}`}
        drills
        disabled={!selection.connected}
        onClick={() => setStep('model')}
      />
      {choices.map(choice => (
        <SettingRow
          key={choice.field}
          icon={optionIcon({
            field: choice.field,
            value: choice.value,
          })}
          name={choice.title}
          value={valueLabel({ choice })}
          drills
          disabled={choice.disabled}
          onClick={() => setStep(choice.field)}
        />
      ))}
      {fast && (
        <SettingRow
          icon={fast.on ? 'fast-on' : 'fast'}
          name="Fast"
          value={fast.on ? 'On' : 'Off'}
          drills={false}
          pressed={fast.on}
          disabled={fast.disabled}
          onClick={fast.toggle}
        />
      )}
    </MenuList>
  )
}

// The composer's settings folded into one button: the model, and a popover listing every setting with its value.
export function AgentSettingsMenu({
  label,
  selection,
  modelLabel,
  accountName,
  choices,
  fast,
  disabled,
  iconSize,
}: {
  label: string
  selection: Selection
  modelLabel: string
  accountName: string
  choices: SettingChoice[]
  fast?: FastSetting
  disabled: boolean
  iconSize: number
}) {
  const provider = PROVIDERS.find(item => item.harness === selection.agent.harness)!
  const effort = choices.find(choice => choice.field === 'effort')
  const fastText = fast && `Fast ${fast.on ? 'on' : 'off'}`
  const summary = [
    provider.label,
    modelLabel,
    ...choices.map(choice => `${choice.title} ${valueLabel({ choice })}`),
    fastText,
  ].filter(Boolean).join(' · ')

  return (
    <Popover
      label={`${label}: ${summary}`}
      className="account-model-picker agent-settings-menu"
      disabled={disabled}
      trigger={(
        <>
          <Icon name={provider.icon} size={iconSize} />
          <span className="agent-settings-model">{modelLabel}</span>
          {effort && (
            <Icon
              name={optionIcon({
                field: 'effort',
                value: effort.value,
              })}
              size={iconSize}
            />
          )}
          {effort && <span className="agent-settings-effort">{valueLabel({ choice: effort })}</span>}
          <Icon name="chevron_down" size={14} />
        </>
      )}
    >
      {({ close }) => (
        <SettingsMenu
          selection={selection}
          modelLabel={modelLabel}
          accountName={accountName}
          choices={choices}
          fast={fast}
          close={close}
        />
      )}
    </Popover>
  )
}
