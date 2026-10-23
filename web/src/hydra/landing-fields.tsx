import type { Landing, Merger } from '../../../src/core/model.ts'
import { Select } from '../components/ui/controls.tsx'

export interface LandingChoice {
  landing: Landing
  merge: Merger
}

export const DEFAULT_LANDING: LandingChoice = {
  landing: 'pr',
  merge: 'owner',
}

const LANDING_OPTIONS = [
  {
    value: 'pr',
    label: 'Pull request',
  },
  {
    value: 'branch',
    label: 'Branch only',
  },
]

const MERGER_OPTIONS = [
  {
    value: 'owner',
    label: 'You',
  },
  {
    value: 'hydra',
    label: 'Hydra, once checks are green',
  },
]

export function landingArgs({ choice }: { choice: LandingChoice }): string[] {
  return [
    '--landing',
    choice.landing,
    '--merge',
    choice.merge,
  ]
}

// Where a project's workers stop: how their work lands, and who merges it.
export function LandingFields({
  name,
  choice,
  disabled,
  onChange,
}: {
  name: string
  choice: LandingChoice
  disabled: boolean
  onChange({ choice }: { choice: LandingChoice }): void
}) {
  return (
    <div className="landing-fields">
      <span className="small">Work lands as</span>
      <Select
        label={`How work lands for ${name}`}
        value={choice.landing}
        options={LANDING_OPTIONS}
        disabled={disabled}
        onChange={({ value }) => onChange({
          choice: {
            ...choice,
            landing: value as Landing,
          },
        })}
      />
      {choice.landing === 'pr' && (
        <>
          <span className="small">Merged by</span>
          <Select
            label={`Who merges pull requests for ${name}`}
            value={choice.merge}
            options={MERGER_OPTIONS}
            disabled={disabled}
            onChange={({ value }) => onChange({
              choice: {
                ...choice,
                merge: value as Merger,
              },
            })}
          />
        </>
      )}
    </div>
  )
}
