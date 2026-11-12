import type { HelperAction } from '#routine-helper/route.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'

type Args = { args: string[] }

// Who may run each command and how long the page waits for it. Every allow-list is read from here.
type Entry = {
  // The page may run it through the server.
  page?: true
  // A page command that waits on an agent, so it gets the longer timeout.
  agent?: true
  // The page may send it again after a lost answer: repeating it changes nothing.
  repeatable?: true
  // What a Pnyx-run worker may run without asking; an empty string allows the whole command.
  worker?: string[]
  // What the routine helper may read, and the task writes its grant can cover.
  helper?: {
    reads?: string[]
    writes?: HelperAction[]
  }
  // Hydra may only propose these; the owner confirms.
  ownerOnly?({ args }: Args): boolean
}

const flag = ({
  args,
  name,
}: Args & { name: string }) => args.some(arg => arg === name || arg.startsWith(`${name}=`))

export const COMMAND_REGISTRY = {
  debug: {
    helper: {
      reads: [
        'timeline',
        'health',
        'performance',
      ],
    },
    worker: [
      'timeline',
      'health',
      'performance',
    ],
  },
  approval: {
    page: true,
    ownerOnly: () => true,
  },
  project: {
    page: true,
    helper: {
      reads: [
        'list',
        'show',
      ],
    },
  },
  task: {
    page: true,
    worker: [
      'show',
      'tools',
      'history',
      'status',
      'chat',
      'messages',
      'inbox read',
      'inbox ack',
    ],
    helper: {
      reads: [
        'list',
        'show',
        'history',
        'chat',
        'messages',
        'sessions',
      ],
      writes: [
        'continue',
        'answer',
        'permission',
      ],
    },
    ownerOnly: ({ args }) => (args[0] === 'permission' && args[1] === HYDRA_CARD)
      || (args[0] === 'copy' && flag({
        args,
        name: '--discard',
      })),
  },
  column: { page: true },
  hydra: {
    page: true,
    worker: [
      'send',
      'history',
      'message',
    ],
    helper: {
      reads: [
        'check',
        'messages',
        'message',
        'show',
      ],
    },
  },
  layout: { page: true },
  // Permission increases are checked against the resulting dispatch document at its write boundary.
  rule: {
    page: true,
    ownerOnly: ({ args }) => [
      'confirm',
      'dismiss',
    ].includes(args[0] ?? ''),
  },
  account: {
    page: true,
  },
  move: { page: true },
  link: {
    page: true,
    worker: [''],
  },
  outcome: { page: true },
  undo: { page: true },
  view: { page: true },
  settings: { page: true },
  history: { page: true },
  card: { page: true },
  integrations: { page: true },
  owner: { helper: { reads: ['memory'] } },
  agent: {
    agent: true,
    repeatable: true,
    ownerOnly: ({ args }) => args[1] === 'mode',
  },
  reply: {
    agent: true,
    repeatable: true,
  },
  'task-message': {
    agent: true,
    repeatable: true,
  },
  answer: {
    agent: true,
    repeatable: true,
  },
  'hydra-agent': { repeatable: true },
  'hydra-agent-change': { repeatable: true },
  setup: { ownerOnly: ({ args }) => args[0] !== 'check' },
  restart: { ownerOnly: () => true },
  upgrade: { ownerOnly: ({ args }) => !args.includes('--check') },
} as const satisfies Record<string, Entry>

type Name = keyof typeof COMMAND_REGISTRY
const entries = Object.entries(COMMAND_REGISTRY) as [Name, Entry][]

type PageName = {
  [K in Name]: (typeof COMMAND_REGISTRY)[K] extends { page: true } ? K : never
}[Name]

// CLI commands exposed to the browser. push and repair stay CLI-only: push reads a file path, repair is maintenance.
export const CLI_COMMANDS = entries.filter(([
  , entry,
]) => entry.page).map(([name]) => name) as PageName[]

const registered = ({ name }: { name: string }): Entry | undefined =>
  (COMMAND_REGISTRY as Record<string, Entry>)[name]

export const waitsOnAgent = ({ name }: { name: string }) => registered({ name })?.agent === true

export const repeatable = ({ name }: { name: string }) => registered({ name })?.repeatable === true

// A worker runs these without asking; any other pnyx-axi command still asks.
export const WORKER_COMMANDS = entries.flatMap(([
  name,
  entry,
]) => (entry.worker ?? []).map(sub => `pnyx-axi ${name}${sub ? ` ${sub}` : ''}`))

export const helperReads = ({ name }: { name: string }): string[] =>
  registered({ name })?.helper?.reads ?? []

export const HELPER_TASK_WRITES: HelperAction[] = [...COMMAND_REGISTRY.task.helper.writes]

export const ownerOnlyCommand = ({
  name,
  args,
}: { name: string } & Args): boolean => registered({ name })?.ownerOnly?.({ args }) ?? false

// Hydra and its routine helper run any pnyx-axi command without asking; the rules above refuse what they may not do.
export const HYDRA_COMMANDS = ['pnyx-axi']
