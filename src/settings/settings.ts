import type { HydraState } from '#app/model.ts'
import { DEFAULT_VIEW, patchView, VIEW_SIZE_LIMITS } from '#preferences/view.ts'
import { DEFAULT_DONE_HOURS, MAX_DONE_HOURS } from '#tasks/retention-rules.ts'
import type { AgentConfig } from '#workers/model.ts'
import { HydraError } from '#store/errors.ts'
import { isSharedViewKey, SETTING_KEYS, SHARED_VIEW_KEYS, type Settings, type SharedView } from './model.ts'

// The same characters the dispatch config accepts for a harness's model or effort flag.
const AGENT_FLAG = /^[\w.:/[\]-]{1,100}$/

export const DEFAULT_REVIEW_MINUTES = 30
// setTimeout's limit, which the review timer schedules with.
const MAX_REVIEW_MINUTES = Math.floor(2_147_483_647 / 60_000)

export const DEFAULT_SETTINGS: Settings = {
  ...pickView({ view: DEFAULT_VIEW }),
  doneAfterHours: DEFAULT_DONE_HOURS,
  reviewMinutes: DEFAULT_REVIEW_MINUTES,
  helper: 'auto',
}

export function pickView({ view }: { view: SharedView }): SharedView {
  return structuredClone(Object.fromEntries(SHARED_VIEW_KEYS.map(key => [
    key,
    view[key],
  ])) as unknown as SharedView)
}

const invalid = ({ detail }: { detail: string }): never => {
  throw new HydraError({
    message: `invalid setting: ${detail}`,
    code: 'VALIDATION_ERROR',
  })
}

// The view part reuses the board's validator, so a setting accepts exactly what view set accepts.
function patchSharedView({
  current,
  input,
}: {
  current: SharedView
  input: Record<string, unknown>
}): SharedView {
  const {
    defaultColumnWidths,
    ...rest
  } = input
  const state = {
    view: {
      ...DEFAULT_VIEW,
      ...current,
    },
    cards: {},
  } as unknown as HydraState
  const next = pickView({
    view: patchView({
      state,
      input: rest,
    }),
  })
  next.defaultColumnWidths = structuredClone(current.defaultColumnWidths)

  if (defaultColumnWidths === undefined) {
    return next
  }

  // Custom columns belong to one Hydra each, so any column id may carry its own default.
  if (typeof defaultColumnWidths !== 'object' || defaultColumnWidths === null || Array.isArray(defaultColumnWidths)) {
    return invalid({ detail: 'defaultColumnWidths' })
  }

  for (const [
    id,
    width,
  ] of Object.entries(defaultColumnWidths)) {
    if (!/^(?:[a-z_]{1,40}|custom:[a-z0-9-]{1,60})$/.test(id)) {
      return invalid({ detail: `defaultColumnWidths.${id}` })
    }

    if (width === null) {
      delete next.defaultColumnWidths[id]
    } else if (!Number.isInteger(width) || (width as number) < VIEW_SIZE_LIMITS.columnWidth.min) {
      return invalid({ detail: `defaultColumnWidths.${id}` })
    } else {
      next.defaultColumnWidths[id] = width as number
    }
  }

  return next
}

function helperSetting({ value }: { value: unknown }): Settings['helper'] {
  if (value === 'auto' || value === 'off') {
    return value
  }

  const agent = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

  if (!agent || typeof agent.model !== 'string' || Object.keys(agent).some(key => ![
    'harness',
    'model',
    'effort',
  ].includes(key))) {
    return invalid({ detail: 'helper takes auto, off or { harness, model, effort }' })
  }

  if (agent.harness !== 'claude' && agent.harness !== 'codex') {
    return invalid({ detail: 'helper harness is claude or codex' })
  }

  if (!AGENT_FLAG.test(agent.model) || (agent.effort !== undefined && (typeof agent.effort !== 'string' || !AGENT_FLAG.test(agent.effort)))) {
    return invalid({ detail: 'helper model and effort take characters a harness flag accepts' })
  }

  const helper: AgentConfig = {
    harness: agent.harness,
    model: agent.model,
  }

  if (agent.effort) {
    helper.effort = agent.effort as string
  }

  return helper
}

// Validates a patch against the current settings and returns the settings it produces.
export function patchSettings({
  current,
  input,
}: {
  current: Settings
  input: unknown
}): Settings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid({ detail: 'expected an object' })
  }

  const patch = input as Record<string, unknown>
  const unknown = Object.keys(patch).filter(key => !SETTING_KEYS.includes(key as never))

  if (unknown.length) {
    return invalid({ detail: `unknown keys ${unknown.join(', ')}` })
  }

  const viewInput = Object.fromEntries(Object.entries(patch)
    .filter(([key]) => isSharedViewKey({ key })))
  const next: Settings = {
    ...structuredClone(current),
    ...patchSharedView({
      current: pickView({ view: current }),
      input: viewInput,
    }),
  }

  if ('doneAfterHours' in patch) {
    const hours = patch.doneAfterHours

    if (hours !== 'off' && (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > MAX_DONE_HOURS)) {
      return invalid({ detail: `doneAfterHours takes off or a number from 0 to ${MAX_DONE_HOURS}` })
    }

    next.doneAfterHours = hours as Settings['doneAfterHours']
  }

  if ('reviewMinutes' in patch) {
    const minutes = patch.reviewMinutes

    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0 || minutes > MAX_REVIEW_MINUTES) {
      return invalid({ detail: `reviewMinutes takes a number from 0 to ${MAX_REVIEW_MINUTES} (0 turns reviews off)` })
    }

    next.reviewMinutes = minutes
  }

  if ('helper' in patch) {
    next.helper = helperSetting({ value: patch.helper })
  }

  return next
}
