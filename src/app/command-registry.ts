import type { HelperAction } from '#routine-helper/route.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'

type Args = { args: string[] }

type Entry = {
  // The page may run it through the server.
  page?: true
  // A page command that waits on an agent, so it gets the longer timeout.
  agent?: true
  // The page may send it again after a lost answer: repeating it changes nothing.
  repeatable?: true
  scope?: {
    reads?: string[]
    own?: string[]
  }
  // What the routine helper may read, and the task writes its grant can cover.
  helper?: {
    reads?: string[]
    writes?: HelperAction[]
  }
  agentNotices?({ args }: Args): boolean
}

const flag = ({
  args,
  name,
}: Args & { name: string }) => args.some(arg => arg === name || arg.startsWith(`${name}=`))

const COMMAND_REGISTRY = {
  page: {
    page: true,
    repeatable: true,
    scope: { reads: [''] },
  },
  debug: {
    scope: { reads: [''] },
    helper: {
      reads: [
        'timeline',
        'health',
        'performance',
      ],
    },
  },
  approval: {
    page: true,
    agentNotices: () => true,
  },
  project: {
    page: true,
    scope: {
      reads: [
        'list',
        'show',
        'memory list',
      ],
    },
    helper: {
      reads: [
        'list',
        'show',
      ],
    },
  },
  task: {
    page: true,
    scope: {
      reads: [
        'list',
        'show',
        'history',
        'updates',
        'messages',
        'chat',
        'sessions',
        'reminders',
        'questions',
        'tools',
        'move',
        'stop',
      ],
      own: [
        'ask',
        'refresh-links',
        'inbox',
        'source',
      ],
    },
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
    agentNotices: ({ args }) => (args[0] === 'permission' && args[1] === HYDRA_CARD)
      || (args[0] === 'copy' && flag({
        args,
        name: '--discard',
      })),
  },
  column: {
    page: true,
    scope: { reads: ['list'] },
  },
  hydra: {
    page: true,
    scope: {
      reads: [
        'list',
        'show',
        'messages',
        'message',
        'history',
        'check',
        'usage',
        'digest',
        'memory list',
        'stop',
        'cancel',
      ],
      own: ['send'],
    },
    helper: {
      reads: [
        'check',
        'messages',
        'message',
        'show',
      ],
    },
  },
  layout: {
    page: true,
    scope: { reads: ['show'] },
  },
  // Permission increases are checked against the resulting dispatch document at its write boundary.
  rule: {
    page: true,
    scope: {
      reads: [
        'list',
        'show',
        'schema',
        'now',
      ],
    },
    agentNotices: ({ args }) => [
      'confirm',
      'dismiss',
    ].includes(args[0] ?? ''),
  },
  account: {
    page: true,
    scope: { reads: ['list'] },
  },
  move: { page: true },
  link: {
    page: true,
    scope: { own: [''] },
  },
  outcome: { page: true },
  undo: { page: true },
  view: {
    page: true,
    scope: {
      reads: [
        'show',
        'schema',
      ],
    },
  },
  settings: {
    page: true,
    scope: {
      reads: [
        'show',
        'schema',
      ],
    },
  },
  history: {
    page: true,
    scope: { reads: [''] },
  },
  card: {
    page: true,
    scope: { reads: [''] },
  },
  integrations: {
    page: true,
    scope: { reads: [''] },
  },
  context: {
    scope: { reads: [''] },
  },
  logs: {
    scope: { reads: [''] },
  },
  oracle: {
    scope: { reads: [''] },
  },
  owner: {
    scope: { reads: ['memory list'] },
    helper: { reads: ['memory'] },
  },
  agent: {
    agent: true,
    repeatable: true,
    agentNotices: ({ args }) => args[1] === 'mode',
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
  setup: {
    scope: { reads: ['check'] },
    agentNotices: ({ args }) => args[0] !== 'check',
  },
  restart: {
    scope: { reads: [''] },
    agentNotices: () => true,
  },
  upgrade: {
    scope: { reads: [''] },
    agentNotices: ({ args }) => !args.includes('--check'),
  },
} as const satisfies Record<string, Entry>

type Name = keyof typeof COMMAND_REGISTRY
const entries = Object.entries(COMMAND_REGISTRY) as [Name, Entry][]

type PageName = {
  [K in Name]: (typeof COMMAND_REGISTRY)[K] extends { page: true } ? K : never
}[Name]

// CLI commands exposed to the browser. push stays CLI-only because it reads a file path.
export const CLI_COMMANDS = entries.filter(([
  , entry,
]) => entry.page).map(([name]) => name) as PageName[]

const registered = ({ name }: { name: string }): Entry | undefined =>
  (COMMAND_REGISTRY as Record<string, Entry>)[name]

export const waitsOnAgent = ({ name }: { name: string }) => registered({ name })?.agent === true

export const repeatable = ({ name }: { name: string }) => registered({ name })?.repeatable === true

export const WORKER_COMMANDS = ['pnyx']

export const workerScope = ({ name }: { name: string }) => registered({ name })?.scope

export const helperReads = ({ name }: { name: string }): string[] =>
  registered({ name })?.helper?.reads ?? []

export const HELPER_TASK_WRITES: HelperAction[] = [...COMMAND_REGISTRY.task.helper.writes]

export const agentNoticeCommand = ({
  name,
  args,
}: { name: string } & Args): boolean => registered({ name })?.agentNotices?.({ args }) ?? false

export const HYDRA_COMMANDS = ['pnyx']
