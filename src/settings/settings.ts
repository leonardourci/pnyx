import { LOG_MODES } from '#app/log-line.ts'
import type { TitanState } from '#app/model.ts'
import { DEFAULT_VIEW, patchView } from '#preferences/view.ts'
import { DEFAULT_DONE_HOURS, MAX_DONE_HOURS } from '#tasks/retention-rules.ts'
import { AGENT_FLAG, type AgentConfig } from '#workers/model.ts'
import { knownHarness } from '#workers/providers.ts'
import { NAME, NAME_RULE } from '#workers/dispatch-check.ts'
import { TitanError } from '#store/errors.ts'
import { TITAN_ID } from '#titan/identity.ts'
import { isSharedViewKey, SETTING_KEYS, SHARED_VIEW_KEYS, type Settings, type SharedView } from './model.ts'

export const DEFAULT_REVIEW_MINUTES = 30
// setTimeout's limit, which the review timer schedules with.
export const MAX_REVIEW_MINUTES = Math.floor(2_147_483_647 / 60_000)
export const DEFAULT_LOG_DAYS = 7
export const MAX_LOG_DAYS = 365
export const DEFAULT_LOG_MAX_MB = 500
export const MAX_LOG_MB = 100_000
const HOST_HEADER = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/

export const DEFAULT_SETTINGS: Settings = {
  ...pickView({ view: DEFAULT_VIEW }),
  doneAfterHours: DEFAULT_DONE_HOURS,
  reviewMinutes: DEFAULT_REVIEW_MINUTES,
  helper: 'auto',
  oracleRememberFilters: false,
  titanOrder: [],
  hiddenTitans: [],
  logs: 'on',
  logDays: DEFAULT_LOG_DAYS,
  logMaxMB: DEFAULT_LOG_MAX_MB,
  allowedHosts: [],
}

// Settings stored before a key existed lack it, so each missing key reads as its default.
export const withDefaults = ({ stored }: { stored: Partial<Settings> }): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  ...structuredClone(Object.fromEntries(Object.entries(stored).filter(([key]) => Object.hasOwn(
    DEFAULT_SETTINGS,
    key,
  )))),
})

export function pickView({ view }: { view: SharedView }): SharedView {
  return structuredClone(Object.fromEntries(SHARED_VIEW_KEYS.map(key => [
    key,
    view[key],
  ])) as unknown as SharedView)
}

const invalid = ({ detail }: { detail: string }): never => {
  throw new TitanError({
    message: `invalid setting: ${detail}`,
    code: 'VALIDATION_ERROR',
  })
}

const distinctNames = ({
  value,
  pattern,
  detail,
}: {
  value: unknown
  pattern: RegExp
  detail: string
}): string[] => {
  const matching = Array.isArray(value) && value.every(name => typeof name === 'string' && pattern.test(name))
  const once = Array.isArray(value) && new Set(value).size === value.length

  if (!matching || !once) {
    return invalid({ detail })
  }

  return [...value] as string[]
}

// The view part reuses the Titan view's validator, so a setting accepts exactly what view set accepts.
function patchSharedView({
  current,
  input,
}: {
  current: SharedView
  input: Record<string, unknown>
}): SharedView {
  const state = {
    view: {},
    cards: {},
  } as unknown as TitanState
  const next = pickView({
    view: patchView({
      state,
      input,
      settings: current,
    }),
  })

  return next
}

function helperSetting({ value }: { value: unknown }): Settings['helper'] {
  if (value === 'auto' || value === 'off') {
    return value
  }

  const agent = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

  if (!agent || typeof agent.model !== 'string' || Object.keys(agent).some(key => ![
    'harness',
    'account',
    'model',
    'effort',
    'fast',
  ].includes(key))) {
    return invalid({ detail: 'helper takes auto, off or { harness, account?, model, effort?, fast? }' })
  }

  if (agent.fast !== undefined && typeof agent.fast !== 'boolean') {
    return invalid({ detail: 'helper fast is true or false' })
  }

  const harness = knownHarness({ name: agent.harness })

  if (!harness) {
    return invalid({ detail: 'helper harness is claude or codex' })
  }

  const modelReadable = AGENT_FLAG.test(agent.model)
  const effortReadable = agent.effort === undefined || (typeof agent.effort === 'string' && AGENT_FLAG.test(agent.effort))

  if (!modelReadable || !effortReadable) {
    return invalid({ detail: 'helper model and effort take characters a harness flag accepts' })
  }

  if (agent.account !== undefined && (typeof agent.account !== 'string' || !NAME.test(agent.account))) {
    return invalid({ detail: `helper account: ${NAME_RULE}` })
  }

  const helper: AgentConfig = {
    harness,
    model: agent.model,
  }

  if (agent.account) {
    helper.account = agent.account as string
  }

  if (agent.effort) {
    helper.effort = agent.effort as string
  }

  // Fast is off unless chosen, so only true is kept.
  if (agent.fast) {
    helper.fast = true
  }

  return helper
}

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

  if ('oracleRememberFilters' in patch) {
    if (typeof patch.oracleRememberFilters !== 'boolean') {
      return invalid({ detail: 'oracleRememberFilters takes true or false' })
    }

    next.oracleRememberFilters = patch.oracleRememberFilters
  }

  if ('logs' in patch) {
    const logs = LOG_MODES.find(mode => mode === patch.logs)

    if (!logs) {
      return invalid({ detail: 'logs takes off, on or detailed' })
    }

    next.logs = logs
  }

  if ('logDays' in patch) {
    const days = patch.logDays

    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_LOG_DAYS) {
      return invalid({ detail: `logDays takes a whole number of days from 1 to ${MAX_LOG_DAYS}` })
    }

    next.logDays = days
  }

  if ('logMaxMB' in patch) {
    const megabytes = patch.logMaxMB

    if (typeof megabytes !== 'number' || !Number.isInteger(megabytes) || megabytes < 1 || megabytes > MAX_LOG_MB) {
      return invalid({ detail: `logMaxMB takes a whole number of megabytes from 1 to ${MAX_LOG_MB}` })
    }

    next.logMaxMB = megabytes
  }

  if ('allowedHosts' in patch) {
    next.allowedHosts = distinctNames({
      value: patch.allowedHosts,
      pattern: HOST_HEADER,
      detail: 'allowedHosts takes a list of lowercase host names such as mac.example.ts.net, each once',
    })
  }

  for (const key of [
    'titanOrder',
    'hiddenTitans',
  ] as const) {
    if (!(key in patch)) {
      continue
    }

    next[key] = distinctNames({
      value: patch[key],
      pattern: TITAN_ID,
      detail: `${key} takes a list of Titan ids, each once`,
    })
  }

  return next
}
