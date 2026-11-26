import { canonicalCommandName, parseCommandArgs } from '#app/command-aliases.ts'
import { inform, withCommandNotices } from '#app/command-notices.ts'
import { workerScope } from '#app/command-registry.ts'
import { commandTitan, guard, type Options } from '#app/cli-support.ts'
import { requestEnv, requestInvocation } from '#app/request-context.ts'
import { loadTitan } from '#app/store.ts'
import { TASK_OPTIONS } from '#app/task-cli.ts'
import { TITAN_OPTIONS } from '#titan/cli.ts'
import { othrysHome } from '#store/storage.ts'
import { canonical } from '#store/paths.ts'
import { SOURCE_OPTIONS } from '#task-sources/cli.ts'
import { LINK_OPTIONS } from '#tasks/delivery/cli.ts'
import { findCard } from '#tasks/push-rules.ts'
import { INBOX_OPTIONS } from './inbox-cli.ts'
import { workerIdentity } from './worker-identity.ts'

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
    TITAN_OPTIONS,
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
  } = parseCommandArgs({
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
  titanId,
  what,
}: {
  task: string
  ref: string | undefined
  titanId: string
  what: string
}): void {
  if (!ref) {
    inform({
      reason: `${what} has no worker task target`,
      clear: 'Use othrys board to find the task ID.',
    })

    return
  }

  const card = findCard({
    state: loadTitan({ titanId }).state,
    ref,
  })

  if (card.id !== task) {
    inform({
      task: card.id,
      reason: `Worker ${task} changed another task`,
      clear: `Read tasks/${card.id}/task.log to inspect the change`,
    })
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
  const home = requestEnv().OTHRYS_WORKER_HOME
  // A symlinked home and its target are one home.
  const ownHome = home === undefined
    || canonical({ path: home }) === canonical({ path: othrysHome() })

  // A worker starting or stopping a server in a scratch home of its own is not working in the home that started it.
  if (!identity || !ownHome) {
    return
  }

  if (declared !== undefined && identity.task !== undefined && declared !== `worker:${identity.task}`) {
    inform({
      reason: `Worker ${identity.task} declared actor ${declared}`,
      clear: `Use othrys with --actor worker:${identity.task} to retain the worker identity`,
    })
  }

  const scope = workerScope({ name })
  const command = requestInvocation().name ?? name

  if (scope?.reads?.some(path => startsWith({
    words,
    path,
  }))) {
    return
  }

  if (!scope?.own?.some(path => startsWith({
    words,
    path,
  }))) {
    inform({
      reason: `${command} is outside the worker’s default commands`,
      clear: 'Use othrys --help for supported actions and the task UI for management.',
    })

    return
  }

  if (name === 'hydra' && values.action !== undefined) {
    inform({
      reason: 'Worker requested a Titan action',
      clear: 'Append a note line to the assigned worker.log for a progress report.',
    })
  }

  if (!identity.task) {
    inform({
      reason: 'Worker has no recorded task identity',
      clear: 'Use othrys with --actor worker:<task> to record the task identity',
    })

    return
  }

  requireOwnTask({
    task: identity.task,
    ref: targetOf({
      name,
      words,
      values,
    }),
    titanId: commandTitan({ hydra: typeof values.hydra === 'string' ? values.hydra : undefined }),
    what: command,
  })
}

type Command = (args: string[]) => unknown

export function workerScoped<T extends Record<string, Command>>({ commands }: { commands: T }): T {
  return Object.fromEntries(Object.entries(commands).map(([
    name,
    run,
  ]) => {
    const check = guard({
      handler: ({ args }) => checkWorkerScope({
        name: canonicalCommandName({ name }),
        args,
      }),
    })

    return [
      name,
      (args: string[]) => {
        return withCommandNotices({
          run: () => {
            check(args)

            return run(args)
          },
        })
      },
    ]
  })) as T
}
