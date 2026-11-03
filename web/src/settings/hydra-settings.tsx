import { HELPER_MODELS, type DoneAfterHours, type HelperSetting } from '#settings/model.ts'
import { useRef } from 'react'
import { DEFAULT_REVIEW_MINUTES, MAX_REVIEW_MINUTES } from '#settings/settings.ts'
import { DEFAULT_DONE_HOURS, MAX_DONE_HOURS } from '#tasks/retention-rules.ts'
import type { AgentConfig } from '#workers/model.ts'
import type { Command } from '#web-app/connection.ts'
import { Button, NumberField, Switch } from '#web-shared/ui/controls.tsx'
import { DISPATCH_CHANGED } from '#web-workers/heads-dispatch.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { AgentPickers } from '#web-workers/agent-pickers.tsx'

// The sliders cover a week of Done and two hours of review; the fields take up to the limits.
const DONE_SLIDER_MAX = 168
const REVIEW_SLIDER_MAX = 120

type Save = ({ patch }: { patch: Record<string, unknown> }) => Promise<boolean>
// Reports a slider's value while it moves, so the preview beside it follows.
type Slide = ({ value }: { value?: number }) => void

export function DispatchStatus({ error }: { error?: string }) {
  return (
    <div className="setting-stack" role="status">
      <p>{error ? `Could not load agent settings: ${error}` : 'Loading agent settings…'}</p>
      {error && (
        <Button onClick={() => window.dispatchEvent(new Event(DISPATCH_CHANGED))}>Retry</Button>
      )}
    </div>
  )
}

export function Help({ text }: { text: string }) {
  return <p className="setting-help"><Icon name="about" size={14} />{text}</p>
}

const doneHelp = ({ hours }: { hours: DoneAfterHours }) => {
  if (hours === 'off') {
    return 'Off: Done cards stay on the board until you hide them yourself.'
  }

  return hours === 0
    ? '0 hours: a card leaves the board as soon as it lands in Done. It stays in History and the Oracle, and task unhide brings it back.'
    : `A card leaves the board after ${hours} h in Done. It stays in History and the Oracle, and task unhide brings it back. 0 hides it right away.`
}

export function HideDone({
  hours,
  save,
  slide,
}: {
  hours: DoneAfterHours
  save: Save
  slide: Slide
}) {
  return (
    <div className="setting-stack">
      <Switch
        label="Hide Done cards"
        caption="Hide them"
        checked={hours !== 'off'}
        onChange={({ value }) => save({ patch: { doneAfterHours: value ? DEFAULT_DONE_HOURS : 'off' } })}
      />
      {hours !== 'off' && (
        <NumberField
          label="Hours in Done"
          value={hours}
          min={0}
          max={MAX_DONE_HOURS}
          step={1}
          slider={{
            max: DONE_SLIDER_MAX,
            initial: DEFAULT_DONE_HOURS,
            unit: 'h',
          }}
          onChange={({ value }) => save({ patch: { doneAfterHours: value } })}
          onSlide={slide}
        />
      )}
      <Help text={doneHelp({ hours })} />
    </div>
  )
}

export function ReviewCadence({
  minutes,
  save,
  slide,
}: {
  minutes: number
  save: Save
  slide: Slide
}) {
  return (
    <div className="setting-stack">
      <NumberField
        label="Review cadence"
        value={minutes}
        min={0}
        max={MAX_REVIEW_MINUTES}
        step={5}
        slider={{
          max: REVIEW_SLIDER_MAX,
          initial: DEFAULT_REVIEW_MINUTES,
          unit: 'min',
        }}
        onChange={({ value }) => save({ patch: { reviewMinutes: value } })}
        onSlide={slide}
      />
      <Help text="0 turns timed reviews off." />
    </div>
  )
}

export function RoutineHelper({
  helper,
  hydra,
  command,
  connected,
  save,
}: {
  helper: HelperSetting
  hydra: AgentConfig
  command: Command
  connected: boolean
  save: Save
}) {
  const lastEnabled = useRef<Exclude<HelperSetting, 'off'>>('auto')

  if (helper !== 'off') {
    lastEnabled.current = helper
  }

  const selected = helper === 'off' ? lastEnabled.current : helper
  const agent = typeof selected === 'object' ? selected : {
    harness: hydra.harness,
    model: HELPER_MODELS[hydra.harness],
  }

  return (
    <div className="setting-stack">
      <Switch
        label="Routine helper"
        caption={helper === 'off' ? 'Off' : 'On'}
        checked={helper !== 'off'}
        onChange={({ value }) => save({
          patch: { helper: value ? lastEnabled.current : 'off' },
        })}
      />
      <span>Provider, account and model</span>
      <AgentPickers
        label="Routine helper agent"
        selectionLabel="Helper account and model"
        agent={agent}
        command={command}
        connected={connected && helper !== 'off'}
        fields={[
          'effort',
          'fast',
        ]}
        defaultAction="none"
        onChange={({ next }) => save({
          patch: {
            helper: {
              harness: next.harness,
              account: next.account,
              model: next.model ?? HELPER_MODELS[next.harness],
              effort: next.effort,
              fast: next.fast || undefined,
            },
          },
        })}
      />
      <Help text="Keep the helper on for efficient coordination. Pnyx suggests a lightweight model; you can choose its harness, account and model independently. Fast stays off unless you turn it on here, or turn Fast on in a Hydra's composer, which also puts that Hydra's helper on Fast where its model has it." />
    </div>
  )
}

export function DefaultAgent({
  rule,
  command,
  connected,
  saveHydra,
}: {
  rule: AgentConfig
  command: Command
  connected: boolean
  saveHydra({ patch }: { patch: Partial<AgentConfig> }): Promise<unknown>
}) {
  return (
    <div className="setting-stack">
      <AgentPickers
        label="Hydra’s default agent"
        defaultAction="edit"
        agent={rule}
        command={command}
        connected={connected}
        onChange={({ next }) => saveHydra({
          patch: {
            harness: next.harness,
            account: next.account,
            model: next.model,
            effort: next.effort,
            mode: next.mode,
            fast: next.fast,
          },
        })}
      />
    </div>
  )
}
