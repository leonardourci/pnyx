import { cliArguments } from './arguments.ts'
import { workerScoped } from '#workers/worker-scope.ts'
import { supervisedCommands } from '#routine-helper/commands.ts'
import { commands } from '#app/cli.ts'
import { workerCommands } from '#workers/workers.ts'
import { dispatchCommands } from '#workers/dispatch-cli.ts'
import { project } from '#projects/cli.ts'
import { oracleCommands } from '#oracle/cli.ts'
import { integrationsCommand } from '#integrations/cli.ts'

const TRANSITIONAL_READ_PATHS: Record<string, string[]> = {
  task: [
    'list',
    'show',
    'history',
    'updates',
    'messages',
    'chat',
    'sessions',
    'reminders',
    'questions',
    'inbox read',
    'tools',
  ],
  hydra: [
    'list',
    'show',
    'messages',
    'message',
    'history',
    'check',
    'digest',
    'memory list',
  ],
  project: [
    'list',
    'show',
    'memory list',
  ],
  owner: ['memory list'],
  rule: [
    'list',
    'show',
    'schema',
    'now',
  ],
  account: ['list'],
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
  debug: [
    'timeline',
    'performance',
  ],
  card: [''],
  context: [''],
  history: [''],
  page: [''],
  integrations: [''],
  oracle: [''],
  logs: [''],
}

const handlers = workerScoped({
  commands: {
    ...commands,
    ...supervisedCommands({
      commands: {
        ...workerCommands,
        ...dispatchCommands,
        project,
        ...oracleCommands,
        integrations: integrationsCommand,
      },
    }),
  },
})

export function readCommand({ argv }: { argv: string[] }) {
  const [
    name = '',
    ...args
  ] = cliArguments({ argv }).tokens.flatMap(token => token.kind === 'positional' ? [token.value] : [])
  const rawArgs = argv.slice(1)
  const paths = Object.hasOwn(
    TRANSITIONAL_READ_PATHS,
    name,
  ) ? TRANSITIONAL_READ_PATHS[name] : undefined
  const allowed = paths?.some(path => path === '' || path.split(' ').every((
    word,
    index,
  ) => args[index] === word))
  const changesTools = name === 'task' && args[0] === 'tools'
    && rawArgs.some(arg => /^--(?:grant|revoke)(?:=|$)/.test(arg))
  const usage = name === 'hydra' && args[0] === 'usage' && args.length === 1

  if ((!allowed && !usage) || changesTools) {
    return undefined
  }

  if (name === 'logs' && args.length) {
    return undefined
  }

  return handlers[name as keyof typeof handlers]
}
