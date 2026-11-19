import { parseArgs } from 'node:util'
import { workerScope } from '#app/command-registry.ts'
import { commandHydra, guard, type Options } from '#app/cli-support.ts'
import { requestEnv, requestInvocation } from '#app/request-context.ts'
import { loadHydra } from '#app/store.ts'
import { TASK_OPTIONS } from '#app/task-cli.ts'
import { HYDRA_OPTIONS } from '#hydra/cli.ts'
import { pnyxHome } from '#store/storage.ts'
import { SOURCE_OPTIONS } from '#task-sources/cli.ts'
import { LINK_OPTIONS } from '#tasks/delivery/cli.ts'
import { findCard } from '#tasks/push-rules.ts'
import { INBOX_OPTIONS } from './inbox-cli.ts'
import { workerIdentity, workerRefusal } from './worker-identity.ts'

// The task subcommands that name their task one word later, and the options each of them takes.
const NESTED_TASK_COMMANDS = new Map<string, Options>([
  [
    'inbox',
    INBOX_OPTIONS,
  ],
  [
    'source',
    SOURCE_OPTIONS,
  ],
])

const COMMAND_OPTIONS = new Map<string, Options>([
  [
    'link',
    LINK_OPTIONS,
  ],
  [
    'hydra',
    HYDRA_OPTIONS,
  ],
])

const startsWith = ({
  words,
  path,
}: {
  words: string[]
  path: string
}) => path === '' || path.split(' ').every((
  word,
  index,
) => words[index] === word)

// The command line split the way the command itself splits it, so a flag's value is never taken for a word.
function split({
  name,
  args,
}: {
  name: string
  args: string[]
}) {
  const nested = name === 'task' ? NESTED_TASK_COMMANDS.get(args[0] ?? '') : undefined
  const {
    values,
    positionals,
  } = parseArgs({
    args: nested ? args.slice(1) : args,
    options: nested ?? COMMAND_OPTIONS.get(name) ?? TASK_OPTIONS,
    allowPositionals: true,
    strict: false,
  })

  return {
    values,
    words: nested ? [
      args[0]!,
      ...positionals,
    ] : positionals,
  }
}

// The task a command line writes to: named one word later for the nested task subcommands, by --task for hydra send.
function targetOf({
  name,
  words,
  values,
}: {
  name: string
  words: string[]
  values: Record<string, string | boolean | (string | boolean)[] | undefined>
}): string | undefined {
  if (name === 'hydra') {
    return typeof values.task === 'string' ? values.task : undefined
  }

  if (name === 'link') {
    return words[0]
  }

  return NESTED_TASK_COMMANDS.has(words[0] ?? '') ? words[2] : words[1]
}

function requireOwnTask({
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
    throw workerRefusal({ message: `${what} needs your own task id (${task})` })
  }

  const card = findCard({
    state: loadHydra({ hydraId }).state,
    ref,
  })

  if (card.id !== task) {
    throw workerRefusal({ message: `${what} on ${card.id} is not yours; a worker writes only to its own task (${task})` })
  }
}

// Refuses a command line a worker may not run. A guardrail against a worker's mistakes, not a sandbox: the worker is whoever
// workerIdentity says it is, and a worker that rewrites its own environment is not stopped.
function checkWorkerScope({
  name,
  args,
}: {
  name: string
  args: string[]
}): void {
  const {
    values,
    words,
  } = split({
    name,
    args,
  })
  const declared = typeof values.actor === 'string' ? values.actor : undefined
  const identity = workerIdentity({ actor: declared })
  const home = requestEnv().PNYX_WORKER_HOME

  // A worker starting or stopping a server in a scratch home of its own is not working in the home that started it.
  if (!identity || (home !== undefined && home !== pnyxHome())) {
    return
  }

  if (declared !== undefined && identity.task !== undefined && declared !== `worker:${identity.task}`) {
    throw workerRefusal({ message: `--actor ${declared} is refused: this worker writes as worker:${identity.task}` })
  }

  const scope = workerScope({ name })
  const command = requestInvocation().name ?? name

  if (scope?.reads?.some(path => startsWith({
    words,
    path,
  }))) {
    return
  }

  // Without --file, `task report` reads the latest stored report of any task.
  if (name === 'task' && words[0] === 'report' && values.file === undefined) {
    return
  }

  if (!scope?.own?.some(path => startsWith({
    words,
    path,
  }))) {
    throw workerRefusal({ message: `${command} is not a worker's command` })
  }

  if (name === 'hydra' && values.action !== undefined) {
    throw workerRefusal({ message: 'hydra send --action is Hydra\'s: a worker sends progress with hydra send --task <its task> --kind progress' })
  }

  if (!identity.task) {
    throw workerRefusal({ message: `${command} needs your own task, but PNYX_ACTOR is missing from your environment; restore it or pass --actor worker:<your task>` })
  }

  requireOwnTask({
    task: identity.task,
    ref: targetOf({
      name,
      words,
      values,
    }),
    hydraId: commandHydra({ hydra: typeof values.hydra === 'string' ? values.hydra : undefined }),
    what: command,
  })
}

// eslint-disable-next-line pnyx/object-params -- The AXI SDK owns the command signature.
type Command = (args: string[]) => unknown

// Wraps every command so a worker's write outside its own task fails before the command runs.
export function workerScoped<T extends Record<string, Command>>({ commands }: { commands: T }): T {
  return Object.fromEntries(Object.entries(commands).map(([
    name,
    run,
  ]) => {
    const check = guard({
      handler: ({ args }) => checkWorkerScope({
        name,
        args,
      }),
    })

    return [
      name,
      // eslint-disable-next-line pnyx/object-params -- The AXI SDK owns the command signature.
      (args: string[]) => {
        check(args)

        return run(args)
      },
    ]
  })) as T
}
