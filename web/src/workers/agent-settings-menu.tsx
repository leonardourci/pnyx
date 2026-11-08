import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Button, type Option } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { MenuOption } from '#web-shared/ui/menu-option.tsx'
import { Popover } from '#web-shared/ui/popover.tsx'
import {
  MENU_MARK_ICON,
  MENU_ROW_ICON,
  MenuHead,
  providerFor,
  SelectionMenu,
  TRIGGER_CHEVRON,
  type Provider,
  type Selection,
} from './account-model-picker.tsx'

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

const currentOption = ({ choice }: { choice: SettingChoice }) =>
  choice.options.find(option => option.value === choice.value)

const valueLabel = ({ choice }: { choice: SettingChoice }) =>
  currentOption({ choice })?.label ?? choice.value

// The Mode row keeps its shield whatever the mode; Effort shows the level's own icon.
const choiceIcon = ({ choice }: { choice: SettingChoice }) =>
  choice.field === 'mode' ? 'mode' : currentOption({ choice })?.icon ?? 'effort'

// True once the row is wider than the room it gets.
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

      const fit = () => setFolded(rowElement.offsetWidth > roomElement.clientWidth)

      // Folding or unfolding under the owner's focus would unmount or hide the control they are using.
      const measure = () => {
        if (!roomElement.contains(document.activeElement)) {
          fit()
        }
      }

      const leave = (event: FocusEvent) => {
        if (!roomElement.contains(event.relatedTarget as Node | null)) {
          fit()
        }
      }

      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(roomElement)
      observer.observe(rowElement)
      roomElement.addEventListener(
        'focusout',
        leave,
      )

      return () => {
        observer.disconnect()
        roomElement.removeEventListener(
          'focusout',
          leave,
        )
      }
    },
    [
      room,
      row,
    ],
  )

  return folded
}

// Arrow keys move focus between a list's rows; Backspace returns to the Settings list.
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
  )].focus()
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
      const current = list.current?.querySelector<HTMLButtonElement>('[data-current] > .account-model-choose:not(:disabled)')
      const first = list.current?.querySelector<HTMLButtonElement>('.account-model-choose:not(:disabled)')
      const target = current ?? first
      target?.focus()
    },
    [],
  )

  return (
    <div
      className="account-model-menu"
      onKeyDown={event => listKeys({
        event,
        back,
      })}
    >
      <MenuHead title={title} back={back} />
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

function SettingsMenuRow({
  icon,
  name,
  value,
  drills,
  pressed,
  current,
  disabled,
  onClick,
}: {
  icon: string
  name: string
  value: string
  drills?: boolean
  pressed?: boolean
  // The row the owner last left, focused again when the list returns.
  current?: boolean
  disabled: boolean
  onClick(): void
}) {
  return (
    <MenuOption
      className="account-model-option"
      aria-label={`${name}: ${value}`}
      data-current={current || undefined}
      disabled={disabled}
    >
      <Button
        className="account-model-choose agent-setting-row"
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon name={icon} size={MENU_ROW_ICON} />
        <span className="agent-setting-text"><span>{name}</span><small>{value}</small></span>
        {drills && <Icon name="chevron_right" size={MENU_MARK_ICON} />}
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
            data-current={current || undefined}
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
              {option.icon && <Icon name={option.icon} size={MENU_ROW_ICON} />}
              <span>{option.label}</span>
              {current && <Icon name="check" size={MENU_MARK_ICON} />}
            </Button>
          </MenuOption>
        )
      })}
    </MenuList>
  )
}

function SettingsMenu({
  provider,
  selection,
  modelLabel,
  accountName,
  choices,
  fast,
  close,
}: {
  provider: Provider
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
  const [
    left,
    setLeft,
  ] = useState<Step>('model')
  const toSettings = () => setStep('settings')

  const open = ({ next }: { next: Step }) => {
    setLeft(next)
    setStep(next)
  }

  const opened = choices.find(choice => choice.field === step)

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

  if (opened) {
    return <ChoiceList choice={opened} back={toSettings} />
  }

  return (
    <MenuList title="Settings">
      <SettingsMenuRow
        icon={provider.icon}
        name="Model"
        value={`${modelLabel} · ${accountName}`}
        drills
        current={left === 'model'}
        disabled={!selection.connected}
        onClick={() => open({ next: 'model' })}
      />
      {choices.map(choice => (
        <SettingsMenuRow
          key={choice.field}
          icon={choiceIcon({ choice })}
          name={choice.title}
          value={valueLabel({ choice })}
          drills
          current={left === choice.field}
          disabled={choice.disabled}
          onClick={() => open({ next: choice.field })}
        />
      ))}
      {fast && (
        <SettingsMenuRow
          icon={fast.on ? 'fast-on' : 'fast'}
          name="Fast"
          value={fast.on ? 'On' : 'Off'}
          pressed={fast.on}
          disabled={fast.disabled}
          onClick={fast.toggle}
        />
      )}
    </MenuList>
  )
}

// The composer's settings folded into one button showing the model and effort, with a popover listing every setting and its value.
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
  const provider = providerFor({ harness: selection.agent.harness })
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
              name={choiceIcon({ choice: effort })}
              size={iconSize}
            />
          )}
          {effort && <span className="agent-settings-effort">{valueLabel({ choice: effort })}</span>}
          <Icon name="chevron_down" size={TRIGGER_CHEVRON} />
        </>
      )}
    >
      {({ close }) => (
        <SettingsMenu
          provider={provider}
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
