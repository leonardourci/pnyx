// The settings a card's Agent tab can change, by typing into the session what its
// harness's own interface takes, on the card's reply route. Pure: delivery and the
// readback of the new value happen elsewhere. Checked against each harness's docs
// and a real session (Claude Code 2.1.299, Codex 0.160.1):
//
// | Setting | Claude Code | Codex |
// |---|---|---|
// | model | `/model <alias>` | only in its /model picker: not offered |
// | effort | `/effort <level>` | Shift+Up and Shift+Down step it for this session |
// | mode | Shift+Tab cycles manual, accept edits and plan, then bypass permissions and auto where enabled | only in its /permissions picker: not offered |
// | fast | `/fast on`, `/fast off` | `/fast` toggles the model's Fast tier |
// | collaboration | | Shift+Tab toggles Plan |
//
// Claude Code saves a typed model, effort or fast mode as the default for new
// sessions, and Codex saves /fast. While its prompt cache is warm, Claude Code asks
// to confirm a model or effort change with Yes selected, so those get one more Enter;
// Enter on an empty prompt does nothing. Firstmate's send presses no such keys, so a
// Firstmate task gets a key's change as a plain request its orchestrator acts on.
import type { ReplyRoute } from './route.ts'

export const KEYS = ['shift-tab', 'shift-up', 'shift-down'] as const
export type Key = (typeof KEYS)[number]
export const KEY_LABEL: Record<Key, string> = { 'shift-tab': 'Shift+Tab', 'shift-up': 'Shift+Up', 'shift-down': 'Shift+Down' }

// What is typed: a command submitted with Enter (confirm adds one more Enter), or one
// key, with what pressing it asks for in words (`<task>` names the Firstmate task).
export type ControlInput = { text: string; confirm?: boolean } | { key: Key; ask: string }

export interface ControlOption { value: string; label: string; input: ControlInput }

export interface Control {
  setting: string
  options: ControlOption[]
  // How the session's next report confirms an option: its value reads back exactly
  // ("equals"), the reported value contains it ("includes", a model alias such as
  // opus for claude-opus-5-5), or the setting differs from before ("changes").
  confirm: 'equals' | 'includes' | 'changes'
}

export interface Controls { controls: Control[]; note?: string }

const typed = ({ values, command, confirm }: {
  values: string[]
  command: string
  confirm?: boolean
}): ControlOption[] => values.map(value => ({ value, label: value, input: { text: `/${command} ${value}`, ...(confirm ? { confirm } : {}) } }))

const HARNESS_CONTROLS: Record<string, Controls> = {
  'claude-code': {
    controls: [
      { setting: 'model', confirm: 'includes', options: typed({ values: ['opus', 'sonnet', 'haiku', 'fable'], command: 'model', confirm: true }) },
      { setting: 'effort', confirm: 'equals', options: typed({ values: ['low', 'medium', 'high', 'xhigh', 'max'], command: 'effort', confirm: true }) },
      { setting: 'mode', confirm: 'changes', options: [{ value: 'next', label: 'Next mode', input: { key: 'shift-tab', ask: 'switch the worker on <task> to the next permission mode (Shift+Tab in its session)' } }] },
      { setting: 'fast', confirm: 'equals', options: typed({ values: ['on', 'off'], command: 'fast' }) },
    ],
    note: 'Claude Code also saves a model, effort or fast mode set here as your default for new sessions. Mode cycles manual, accept edits and plan, then bypass permissions and auto where enabled.',
  },
  'codex': {
    controls: [
      {
        setting: 'effort',
        confirm: 'changes',
        options: [
          { value: 'lower', label: 'Lower', input: { key: 'shift-down', ask: 'lower the reasoning effort of the worker on <task> by one step (Shift+Down in its Codex session)' } },
          { value: 'raise', label: 'Raise', input: { key: 'shift-up', ask: 'raise the reasoning effort of the worker on <task> by one step (Shift+Up in its Codex session)' } },
        ],
      },
      { setting: 'fast', confirm: 'changes', options: [{ value: 'toggle', label: 'Toggle', input: { text: '/fast' } }] },
      { setting: 'collaboration', confirm: 'changes', options: [{ value: 'toggle', label: 'Toggle plan', input: { key: 'shift-tab', ask: 'toggle Plan mode for the worker on <task> between turns (Shift+Tab in its Codex session)' } }] },
    ],
    note: 'Codex picks its model and approval mode only in its own /model and /permissions pickers, so change those in the session. /fast exists only for models with a Fast tier and Codex saves it as your default; Shift+Tab works only between turns.',
  },
}

// The controls a session of this harness offers; none for a harness Pnyx has not checked.
export function harnessControls({ provider }: { provider?: string }): Controls | undefined {
  return provider === undefined ? undefined : HARNESS_CONTROLS[provider]
}

export function findOption({ provider, setting, value }: {
  provider: string | undefined
  setting: string
  value: string
}): { control: Control; option: ControlOption } | undefined {
  const control = harnessControls({ provider })?.controls.find(c => c.setting === setting)
  const option = control?.options.find(o => o.value === value)

  return control && option ? { control, option } : undefined
}

// Why a route cannot carry this input, or undefined when it can. Text goes wherever
// a reply goes, except to the Firstmate tasks whose send would not type it (checked
// with the task's meta in the Firstmate integration); a key goes to a Firstmate task
// as a request (keyRequest), and otherwise needs a host that presses keys.
export function inputReason({ kind, input }: { kind: ReplyRoute['kind']; input: { key: Key } | { text: string } }): string | undefined {
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

// The plain request a Firstmate task gets for a key fm-send cannot press: no slash and
// no key, so its orchestrator reads it and acts on its worker.
export function keyRequest({ input, task }: {
  input: { key: Key; ask: string }
  task: string
}): string {
  return `Please ${input.ask.replace('<task>', task)}.`
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
