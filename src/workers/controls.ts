import { fastWord } from './transcript-content.ts'
import type { ReplyRoute } from './reply-route.ts'

export type Key = 'shift-tab' | 'shift-up' | 'shift-down'
export const KEY_LABEL: Record<Key, string> = {
  'shift-tab': 'Shift+Tab',
  'shift-up': 'Shift+Up',
  'shift-down': 'Shift+Down',
}

// set: a Pnyx-hosted agent takes the value directly, nothing typed.
export type ControlInput =
  | {
    text: string
    confirm?: boolean
  }
  | { key: Key }
  | { set: string }

export interface ControlOption {
  value: string
  label: string
  input: ControlInput
}

export interface Control {
  setting: string
  options: ControlOption[]
  // How the session's next report confirms an option: its value reads back exactly
  // ("equals"), the reported value contains it ("includes", a model alias such as
  // opus for claude-opus-5-5), or the setting differs from before ("changes").
  confirm: 'equals' | 'includes' | 'changes'
}

export interface Controls {
  name: string
  controls: Control[]
  note?: string
}

const typed = ({
  values,
  command,
  confirm,
}: {
  values: string[]
  command: string
  confirm?: boolean
}): ControlOption[] => values.map(value => ({
  value,
  label: value,
  input: {
    text: `/${command} ${value}`,
    ...(confirm ? { confirm } : {}),
  },
}))

const HARNESS_CONTROLS: Record<string, Controls> = {
  'claude-code': {
    name: 'Claude Code',
    controls: [
      {
        setting: 'model',
        confirm: 'includes',
        options: typed({
          values: [
            'opus',
            'sonnet',
            'haiku',
            'fable',
          ],
          command: 'model',
          confirm: true,
        }),
      },
      {
        setting: 'effort',
        confirm: 'equals',
        options: typed({
          values: [
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
          ],
          command: 'effort',
          confirm: true,
        }),
      },
      {
        setting: 'mode',
        confirm: 'changes',
        options: [
          {
            value: 'next',
            label: 'Next mode',
            input: { key: 'shift-tab' },
          },
        ],
      },
      {
        setting: 'fast',
        confirm: 'equals',
        options: typed({
          values: [
            'on',
            'off',
          ],
          command: 'fast',
        }),
      },
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
          {
            value: 'lower',
            label: 'Lower',
            input: { key: 'shift-down' },
          },
          {
            value: 'raise',
            label: 'Raise',
            input: { key: 'shift-up' },
          },
        ],
      },
      {
        setting: 'fast',
        confirm: 'changes',
        options: [
          {
            value: 'toggle',
            label: 'Toggle',
            input: { text: '/fast' },
          },
        ],
      },
      {
        setting: 'collaboration',
        confirm: 'changes',
        options: [
          {
            value: 'toggle',
            label: 'Toggle plan',
            input: { key: 'shift-tab' },
          },
        ],
      },
    ],
    note: 'Codex picks its model and approval mode only in its own /model and /permissions pickers, so change those in the session. /fast exists only for models with a Fast tier and Codex saves it as your default; Shift+Tab works only between turns.',
  },
}

const set = ({
  values,
  labels = {},
}: {
  values: string[]
  labels?: Record<string, string>
}): ControlOption[] => values.map(value => ({
  value,
  label: labels[value] ?? value,
  input: { set: value },
}))

const HOSTED_CLAUDE: Controls = {
  name: 'Claude Code',
  controls: [
    {
      setting: 'model',
      confirm: 'includes',
      options: set({
        values: [
          'opus',
          'sonnet',
          'haiku',
          'fable',
        ],
      }),
    },
    {
      setting: 'effort',
      confirm: 'equals',
      options: set({
        values: [
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
        ],
      }),
    },
    {
      setting: 'mode',
      confirm: 'equals',
      options: set({
        values: [
          'default',
          'acceptEdits',
          'plan',
          'auto',
          'bypassPermissions',
        ],
        labels: {
          default: 'Ask permissions',
          acceptEdits: 'Accept edits',
          plan: 'Plan',
          auto: 'Auto',
          bypassPermissions: 'Bypass permissions',
        },
      }),
    },
  ],
  note: 'Pnyx runs this agent, so a change applies to this session only and is kept for its next turns. Permission requests appear on the task with Allow and Deny.',
}

const HOSTED_CODEX: Controls = {
  name: 'Codex',
  controls: [
    {
      setting: 'model',
      confirm: 'equals',
      options: set({
        values: [
          'gpt-6.1-sol',
          'gpt-6-astra',
          'gpt-6-sol',
          'gpt-6-luna',
        ],
      }),
    },
    {
      setting: 'effort',
      confirm: 'equals',
      options: set({
        values: [
          'low',
          'medium',
          'high',
          'xhigh',
        ],
      }),
    },
    // bypassPermissions is never under Claude Code's name, so a bypass Hydra can pass it to a Codex worker.
    {
      setting: 'mode',
      confirm: 'equals',
      options: set({
        values: [
          'untrusted',
          'on-request',
          'never',
          'bypassPermissions',
        ],
        labels: {
          'untrusted': 'Ask unless trusted',
          'on-request': 'Ask on request',
          'never': 'Never ask, full access',
          'bypassPermissions': 'Bypass permissions',
        },
      }),
    },
  ],
  note: 'Pnyx keeps these settings for the next turn. Permission requests appear on the task with Allow and Deny. Never and Bypass permissions run with full access; the other modes write only in the task folder and Pnyx’s home.',
}

export function harnessControls({
  provider,
  hosted = false,
}: {
  provider?: string
  hosted?: boolean
}): Controls | undefined {
  if (hosted && provider === 'claude-code') {
    return HOSTED_CLAUDE
  }

  if (hosted && provider === 'codex') {
    return HOSTED_CODEX
  }

  return provider === undefined ? undefined : HARNESS_CONTROLS[provider]
}

export function findOption({
  provider,
  setting,
  value,
  hosted = false,
}: {
  provider: string | undefined
  setting: string
  value: string
  hosted?: boolean
}): {
  control: Control
  option: ControlOption
} | undefined {
  const harness = harnessControls({
    provider,
    hosted,
  })
  const control = harness?.controls.find(c => c.setting === setting)
  const option = control?.options.find(o => o.value === value)

  return control && option ? {
    control,
    option,
  } : undefined
}

export function inputReason({
  kind,
  input,
}: {
  kind: ReplyRoute['kind']
  input: ControlInput
}): string | undefined {
  if ((kind === 'pnyx') !== ('set' in input)) {
    return kind === 'pnyx' ? 'Pnyx sets this agent\'s settings directly.' : 'Only an agent Pnyx runs takes this setting directly.'
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

export function confirms({
  control,
  option,
  before,
  after,
}: {
  control: Control
  option: ControlOption
  before: string | undefined
  after: string | undefined
}): boolean {
  if (after === undefined) {
    return false
  }

  // Fast is stored as true or false; the control's values are the owner's on and off.
  const seen = control.setting === 'fast' ? fastWord({ value: after }) : after

  switch (control.confirm) {
    case 'equals': return seen === option.value
    case 'includes': return after.includes(option.value)
    default: return after !== before
  }
}
