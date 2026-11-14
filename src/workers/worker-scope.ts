import { parseArgs } from 'node:util'
import { AxiError } from 'axi-sdk-js'
import { requestEnv } from '#app/request-context.ts'
import { loadHydra } from '#app/store.ts'
import { TASK_OPTIONS } from '#app/task-cli.ts'
import { DEFAULT_HYDRA } from '#app/home-migration.ts'
import { findCard } from '#tasks/push-rules.ts'

const WORKER_PREFIX = 'worker:'

export const WORKER_SCOPE_CODE = 'WORKER_SCOPE'

const WORKER_SCOPE = 'A worker writes only to its own task: task status, task ask, task report, task report-review, task refresh-links, task inbox, task source, link, and hydra send --task <its task>'

// Subcommands a worker runs on any task or Hydra: reads, and commands that refuse a worker themselves. One listed with no subcommand is open whole.
const OPEN: Record<string, string[]> = {
  debug: [],
  oracle: [],
  page: [],
  card: [],
  context: [],
  history: [],
  integrations: [],
  logs: [],
  task: [
    'list',
    'show',
    'history',
    'updates',
    'messages',
    'chat',
    'sessions',
    'tools',
    'move',
  ],
  hydra: [
    'list',
    'homes',
    'show',
    'messages',
    'message',
    'history',
    'check',
  ],
  project: [
    'list',
    'show',
    'memory list',
  ],
  column: ['list'],
  settings: [
    'show',
    'schema',
  ],
  view: [
    'show',
    'schema',
  ],
  layout: ['show'],
  rule: [
    'list',
    'show',
    'schema',
    'now',
  ],
  account: ['list'],
  setup: ['check'],
  upgrade: [],
  restart: [],
}

// Task subcommands a worker runs on its own task only; inbox and source name the task one word later.
const OWN_TASK_ACTIONS = [
  'status',
  'ask',
  'report',
  'report-review',
  'refresh-links',
  'inbox',
  'source',
]

const NESTED_TASK_ACTIONS = [
  'inbox',
  'source',
]

const OPTIONS = {
  ...TASK_OPTIONS,
  state: { type: 'string' as const },
  remove: { type: 'boolean' as const },
  task: { type: 'string' as const },
}

const startsWith = ({
  args,
  path,
}: {
  args: string[]
  path: string
}) => path.split(' ').every((
  word,
  index,
) => args[index] === word)

// The worker's own task: the actor Pnyx set in its environment, or the one a worker Pnyx does not run declares.
export function workerTask({
  env = requestEnv(),
  args,
}: {
  env?: NodeJS.ProcessEnv
  args: string[]
}): string | undefined {
  const declared = declaredActor({ args })
  const actor = env.PNYX_ACTOR || declared

  return actor?.startsWith(WORKER_PREFIX) ? actor.slice(WORKER_PREFIX.length) : undefined
}

function declaredActor({ args }: { args: string[] }): string | undefined {
  const { values } = parseArgs({
    args,
    options: { actor: { type: 'string' } },
    strict: false,
  })

  return typeof values.actor === 'string' ? values.actor : undefined
}

function refuse({ message }: { message: string }): never {
  throw new AxiError(
    message,
    WORKER_SCOPE_CODE,
    [
      `Allowed for a worker: ${WORKER_SCOPE}`,
      'Ask Hydra with `pnyx-axi task ask <task> --question "<what you need>"` for anything else',
    ],
  )
}

function ownTask({
  task,
  ref,
  hydraId,
  what,
}: {
  task: string
  ref: string | undefined
  hydraId: string
  what: string
}): void {
  if (!ref) {
    refuse({ message: `${what} needs your own task id (${task})` })
  }

  const card = findCard({
    state: loadHydra({ hydraId }).state,
    ref,
  })

  if (card.id !== task) {
    refuse({ message: `${what} on ${card.id} is not yours; a worker writes only to its own task (${task})` })
  }
}

// Refuses a command line a worker may not run. The worker is whoever PNYX_ACTOR says it is; --actor can only repeat that.
export function checkWorkerScope({
  name,
  args,
  env = requestEnv(),
}: {
  name: string
  args: string[]
  env?: NodeJS.ProcessEnv
}): void {
  const task = workerTask({
    env,
    args,
  })

  if (!task) {
    return
  }

  const declared = declaredActor({ args })

  if (env.PNYX_ACTOR && declared !== undefined && declared !== env.PNYX_ACTOR) {
    refuse({ message: `--actor ${declared} is refused: this worker writes as ${env.PNYX_ACTOR}` })
  }

  const {
    values,
    positionals: words,
  } = parseArgs({
    args,
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
  })
  const hydraId = typeof values.hydra === 'string' ? values.hydra : env.PNYX_HYDRA || DEFAULT_HYDRA
  const open = OPEN[name]

  if (open && (!open.length || open.some(path => startsWith({
    args: words,
    path,
  })))) {
    if (name === 'logs' && words[0] === 'clean') {
      refuse({ message: 'logs clean deletes every Hydra\'s log files' })
    }

    return
  }

  const action = words[0] ?? ''

  if (name === 'task' && OWN_TASK_ACTIONS.includes(action)) {
    ownTask({
      task,
      ref: NESTED_TASK_ACTIONS.includes(action) ? words[2] : words[1],
      hydraId,
      what: `task ${action}`,
    })

    return
  }

  if (name === 'link') {
    ownTask({
      task,
      ref: words[0],
      hydraId,
      what: 'link',
    })

    return
  }

  if (name === 'hydra' && action === 'send' && values.action === undefined) {
    ownTask({
      task,
      ref: typeof values.task === 'string' ? values.task : undefined,
      hydraId,
      what: 'hydra send',
    })

    return
  }

  refuse({
    message: `${[
      name,
      action,
    ].filter(Boolean).join(' ')} is not a worker's command`,
  })
}

// eslint-disable-next-line pnyx/object-params -- The AXI SDK owns the command signature.
type Command = (args: string[]) => unknown

// Wraps every command so a worker's write outside its own task fails before the command runs.
export function workerScoped<T extends Record<string, Command>>({ commands }: { commands: T }): T {
  return Object.fromEntries(Object.entries(commands).map(([
    name,
    run,
  ]) => [
    name,
    // eslint-disable-next-line pnyx/object-params -- The AXI SDK owns the command signature.
    (args: string[]) => {
      checkWorkerScope({
        name,
        args,
      })

      return run(args)
    },
  ])) as T
}
