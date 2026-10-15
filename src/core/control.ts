import type { ReplyRoute } from './route.ts'

export const KEYS = ['shift-tab', 'shift-up', 'shift-down'] as const
export type Key = (typeof KEYS)[number]
export const KEY_LABEL: Record<Key, string> = { 'shift-tab': 'Shift+Tab', 'shift-up': 'Shift+Up', 'shift-down': 'Shift+Down' }

// set: a Pnyx-hosted agent takes the value directly, nothing typed.
export type ControlInput =
  | { text: string; confirm?: boolean }
  | { key: Key }
  | { request: true }
  | { set: string }

// ask is the change in words for a Firstmate request, `<worker>` standing for the task's worker.
export interface ControlOption { value: string; label: string; input: ControlInput; ask: string }

export interface Control {
  setting: string
  options: ControlOption[]
  // How the session's next report confirms an option: its value reads back exactly
  // ("equals"), the reported value contains it ("includes", a model alias such as
  // opus for claude-opus-5-5), or the setting differs from before ("changes").
  confirm: 'equals' | 'includes' | 'changes'
}

export interface Controls { name: string; controls: Control[]; note?: string }

const typed = ({ values, command, name, confirm }: {
  values: string[]
  command: string
  name: string
  confirm?: boolean
}): ControlOption[] => values.map(value => ({
  value,
  label: value,
  input: { text: `/${command} ${value}`, ...(confirm ? { confirm } : {}) },
  ask: `switch <worker> to ${name} ${value}`,
}))

const HARNESS_CONTROLS: Record<string, Controls> = {
  'claude-code': {
    name: 'Claude Code',
    controls: [
      { setting: 'model', confirm: 'includes', options: typed({ values: ['opus', 'sonnet', 'haiku', 'fable'], command: 'model', name: 'model', confirm: true }) },
      { setting: 'effort', confirm: 'equals', options: typed({ values: ['low', 'medium', 'high', 'xhigh', 'max'], command: 'effort', name: 'effort', confirm: true }) },
      { setting: 'mode', confirm: 'changes', options: [{ value: 'next', label: 'Next mode', input: { key: 'shift-tab' }, ask: 'switch <worker> to the next permission mode' }] },
      { setting: 'fast', confirm: 'equals', options: typed({ values: ['on', 'off'], command: 'fast', name: 'fast mode' }) },
    ],
    note: 'Claude Code also saves a model, effort or fast mode set here as your default for new sessions. Mode cycles manual, accept edits and plan, then bypass permissions and auto where enabled.',
  },
  'codex': {
    name: 'Codex',
    controls: [
      {
        setting: 'effort',
        confirm: 'changes',
        options: [
          { value: 'lower', label: 'Lower', input: { key: 'shift-down' }, ask: 'lower the reasoning effort of <worker> by one step' },
          { value: 'raise', label: 'Raise', input: { key: 'shift-up' }, ask: 'raise the reasoning effort of <worker> by one step' },
        ],
      },
      { setting: 'fast', confirm: 'changes', options: [{ value: 'toggle', label: 'Toggle', input: { text: '/fast' }, ask: 'toggle fast mode for <worker>' }] },
      { setting: 'collaboration', confirm: 'changes', options: [{ value: 'toggle', label: 'Toggle plan', input: { key: 'shift-tab' }, ask: 'toggle Plan mode for <worker>' }] },
    ],
    note: 'Codex picks its model and approval mode only in its own /model and /permissions pickers, so change those in the session. /fast exists only for models with a Fast tier and Codex saves it as your default; Shift+Tab works only between turns.',
  },
}

const set = ({ values, name }: {
  values: string[]
  name: string
}): ControlOption[] => values.map(value => ({
  value,
  label: value,
  input: { set: value },
  ask: `switch <worker> to ${name} ${value}`,
}))

const HOSTED_CLAUDE: Controls = {
  name: 'Claude Code',
  controls: [
    { setting: 'model', confirm: 'includes', options: set({ values: ['opus', 'sonnet', 'haiku', 'fable'], name: 'model' }) },
    { setting: 'effort', confirm: 'equals', options: set({ values: ['low', 'medium', 'high', 'xhigh', 'max'], name: 'effort' }) },
    { setting: 'mode', confirm: 'equals', options: set({ values: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'], name: 'permission mode' }) },
  ],
  note: 'Pnyx runs this agent, so a change applies to this session only and is kept for its next turns. Permission requests appear on the task with Allow and Deny.',
}

const HOSTED_CODEX: Controls = {
  name: 'Codex',
  controls: [
    { setting: 'model', confirm: 'equals', options: set({ values: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'], name: 'model' }) },
    { setting: 'effort', confirm: 'equals', options: set({ values: ['low', 'medium', 'high', 'xhigh'], name: 'effort' }) },
    { setting: 'mode', confirm: 'equals', options: set({ values: ['untrusted', 'on-request', 'never'], name: 'approval policy' }) },
  ],
  note: 'Pnyx keeps these settings for the next turn. Permission requests appear on the task with Allow and Deny; the sandbox follows your Codex configuration.',
}

const CODEX_REQUESTS: Control[] = [
  {
    setting: 'model',
    confirm: 'equals',
    options: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'].map(value => ({
      value,
      label: value,
      input: { request: true },
      ask: `switch <worker> to model ${value}`,
    })),
  },
  {
    setting: 'approval',
    confirm: 'equals',
    options: ['untrusted', 'on-request', 'never'].map(value => ({
      value,
      label: value,
      input: { request: true },
      ask: `switch <worker> to approval policy ${value}`,
    })),
  },
]

export function harnessControls({ provider, firstmate = false, hosted = false }: {
  provider?: string
  firstmate?: boolean
  hosted?: boolean
}): Controls | undefined {
  if (hosted && provider === 'claude-code') {
    return HOSTED_CLAUDE
  }

  if (hosted && provider === 'codex') {
    return HOSTED_CODEX
  }

  const harness = provider === undefined ? undefined : HARNESS_CONTROLS[provider]

  return provider === 'codex' && firstmate && harness
    ? { ...harness, controls: [...CODEX_REQUESTS, ...harness.controls], note: 'Every change asks Firstmate’s orchestrator in a request note. The worker reports the applied setting on its next hook or turn.' }
    : harness
}

export function findOption({ provider, setting, value, firstmate = false, hosted = false }: {
  provider: string | undefined
  setting: string
  value: string
  firstmate?: boolean
  hosted?: boolean
}): { control: Control; option: ControlOption } | undefined {
  const harness = harnessControls({ provider, firstmate, hosted })
  const control = harness?.controls.find(c => c.setting === setting)
  const option = control?.options.find(o => o.value === value)

  return control && option ? { control, option } : undefined
}

export function inputReason({ kind, input }: { kind: ReplyRoute['kind']; input: ControlInput }): string | undefined {
  if (kind === 'paseo-agent') {
    return 'Change this agent\'s settings in Paseo.'
  }

  if ((kind === 'pnyx') !== ('set' in input)) {
    return kind === 'pnyx' ? 'Pnyx sets this agent\'s settings directly.' : 'Only an agent Pnyx runs takes this setting directly.'
  }

  if ('request' in input) {
    return kind === 'firstmate' ? undefined : 'This setting can only be requested through Firstmate.'
  }

  if (!('key' in input)) {
    return undefined
  }

  const key = KEY_LABEL[input.key]

  switch (kind) {
    case 'terminal-app': return `Terminal types whole lines, so Pnyx cannot press ${key} there.`
    case 'herdr': return `Pnyx does not press keys such as ${key} in Herdr yet.`
    default: return undefined
  }
}

export function settingRequest({ option, task, harness }: {
  option: ControlOption
  task: string
  harness: string
}): string {
  return `Pnyx: please ${option.ask.replace('<worker>', `the worker on task ${task} (${harness})`)}.`
}

export function confirms({ control, option, before, after }: {
  control: Control
  option: ControlOption
  before: string | undefined
  after: string | undefined
}): boolean {
  if (after === undefined) {
    return false
  }

  switch (control.confirm) {
    case 'equals': return after === option.value
    case 'includes': return after.includes(option.value)
    default: return after !== before
  }
}
