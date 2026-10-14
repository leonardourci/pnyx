// The settings a card's Agent tab can change, by typing into the session what its
// harness's own interface takes, on the card's reply route, or on a Firstmate task by
// asking its orchestrator in a request note (settingRequest). Pure: delivery and the
// readback of the new value happen elsewhere. Checked against each harness's docs
// and a real session (Claude Code 2.1.299, Codex 0.160.1):
//
// | Setting | Claude Code | Codex |
// |---|---|---|
// | model | `/model <alias>` | /model picker directly; Firstmate request otherwise |
// | effort | `/effort <level>` | Shift+Up and Shift+Down step it for this session |
// | mode | Shift+Tab cycles manual, accept edits and plan, then bypass permissions and auto where enabled | /permissions picker directly; Firstmate approval request otherwise |
// | fast | `/fast on`, `/fast off` | `/fast` toggles the model's Fast tier |
// | collaboration | | Shift+Tab toggles Plan |
//
// Claude Code saves a typed model, effort or fast mode as the default for new
// sessions, and Codex saves /fast. While its prompt cache is warm, Claude Code asks
// to confirm a model or effort change with Yes selected, so those get one more Enter;
// Enter on an empty prompt does nothing.
import type { ReplyRoute } from './route.ts'

export const KEYS = ['shift-tab', 'shift-up', 'shift-down'] as const
export type Key = (typeof KEYS)[number]
export const KEY_LABEL: Record<Key, string> = { 'shift-tab': 'Shift+Tab', 'shift-up': 'Shift+Up', 'shift-down': 'Shift+Down' }

// Request-only options carry no text or key that could reach a terminal.
export type ControlInput = { text: string; confirm?: boolean } | { key: Key } | { request: true }

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
  // The setting as a request names it.
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

// The controls a session of this harness offers; none for a harness Pnyx has not checked.
export function harnessControls({ provider, firstmate = false }: {
  provider?: string
  firstmate?: boolean
}): Controls | undefined {
  const harness = provider === undefined ? undefined : HARNESS_CONTROLS[provider]

  return provider === 'codex' && firstmate && harness
    ? { ...harness, controls: [...CODEX_REQUESTS, ...harness.controls], note: 'Every change asks Firstmate’s orchestrator in a request note. The worker reports the applied setting on its next hook or turn.' }
    : harness
}

export function findOption({ provider, setting, value, firstmate = false }: {
  provider: string | undefined
  setting: string
  value: string
  firstmate?: boolean
}): { control: Control; option: ControlOption } | undefined {
  const harness = harnessControls({ provider, firstmate })
  const control = harness?.controls.find(c => c.setting === setting)
  const option = control?.options.find(o => o.value === value)

  return control && option ? { control, option } : undefined
}

// Why a route cannot carry this input, or undefined when it can. Text goes wherever
// a reply goes and a key needs a host that presses keys; a Firstmate task gets every
// change as a request note, so it takes any input.
export function inputReason({ kind, input }: { kind: ReplyRoute['kind']; input: ControlInput }): string | undefined {
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

// The request note a Firstmate task's orchestrator gets for a change to its worker,
// which Pnyx never types into: it names the task, the harness and the wanted setting.
export function settingRequest({ option, task, harness }: {
  option: ControlOption
  task: string
  harness: string
}): string {
  return `Pnyx: please ${option.ask.replace('<worker>', `the worker on task ${task} (${harness})`)}.`
}

// Whether the session's reported value confirms the option sent while it reported before.
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
