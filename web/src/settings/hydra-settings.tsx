import { HELPER_MODELS, type DoneAfterHours, type HelperSetting } from '#settings/model.ts'
import { DEFAULT_REVIEW_MINUTES, MAX_REVIEW_MINUTES } from '#settings/settings.ts'
import { DEFAULT_DONE_HOURS, MAX_DONE_HOURS } from '#tasks/retention-rules.ts'
import type { AgentConfig } from '#workers/model.ts'
import type { Command } from '#web-app/connection.ts'
import { NumberField, Switch } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Segmented } from '#web-shared/ui/segmented.tsx'
import { AgentPickers } from '#web-workers/agent-pickers.tsx'

// The sliders cover a week of Done and two hours of review; the fields take up to the limits.
const DONE_SLIDER_MAX = 168
const REVIEW_SLIDER_MAX = 120

type Save = ({ patch }: { patch: Record<string, unknown> }) => Promise<boolean>
// Reports a slider's value while it moves, so the preview beside it follows.
type Slide = ({ value }: { value?: number }) => void

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

const HELPER_CHOICES = [
  {
    value: 'auto',
    label: 'Auto',
    icon: 'helper',
  },
  {
    value: 'off',
    label: 'Off',
    icon: 'close',
  },
  {
    value: 'pick',
    label: 'Choose',
    icon: 'agent',
  },
]

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
  return (
    <div className="setting-stack">
      <Segmented
        label="Routine helper"
        value={typeof helper === 'object' ? 'pick' : helper}
        options={HELPER_CHOICES}
        onChange={({ value }) => save({
          patch: {
            helper: value === 'pick' ? {
              harness: hydra.harness,
              model: HELPER_MODELS[hydra.harness],
            } : value,
          },
        })}
      />
      {typeof helper === 'object' && (
        <AgentPickers
          label="Routine helper agent"
          agent={helper}
          command={command}
          connected={connected}
          fields={['effort']}
          onChange={({ next }) => save({
            patch: {
              helper: {
                harness: next.harness,
                model: next.model ?? HELPER_MODELS[next.harness],
                effort: next.effort,
              },
            },
          })}
        />
      )}
      <Help text={`Auto uses Sonnet when Hydra runs on Claude and ${HELPER_MODELS.codex} when it runs on Codex. Off sends every wake to the main Hydra.`} />
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
        agent={rule}
        command={command}
        connected={connected}
        onChange={({ next }) => saveHydra({
          patch: {
            harness: next.harness,
            model: next.model,
            effort: next.effort,
            mode: next.mode,
            fast: next.fast,
          },
        })}
      />
      <Help text="The same pickers as Hydra’s chat composer. Picking a model from the other harness resets effort and permissions to that harness’s defaults." />
    </div>
  )
}
