import { parseArgs } from 'node:util'
import { commands } from '#app/cli.ts'
import { workerCommands } from '#workers/workers.ts'
import { dispatchCommands } from '#workers/dispatch-cli.ts'
import { project } from '#projects/cli.ts'
import { oracleCommands } from '#oracle/cli.ts'
import { integrationsCommand } from '#integrations/cli.ts'

// Removed with the app's file-store cutover; current agent contexts still name these reads.
const READ_PATHS: Record<string, string[]> = {
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
    'usage',
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

const handlers = {
  ...commands,
  ...workerCommands,
  ...dispatchCommands,
  project,
  ...oracleCommands,
  integrations: integrationsCommand,
}

export function readCommand({ argv }: { argv: string[] }) {
  const [
    name = '',
    ...args
  ] = argv
  const paths = Object.hasOwn(
    READ_PATHS,
    name,
  ) ? READ_PATHS[name] : undefined
  const allowed = paths?.some(path => path === '' || path.split(' ').every((
    word,
    index,
  ) => args[index] === word))
  const changesTools = name === 'task' && args[0] === 'tools'
    && args.some(arg => /^--(?:grant|revoke)(?:=|$)/.test(arg))

  if (!allowed || changesTools) {
    return undefined
  }

  if (name === 'logs' && parseArgs({
    args,
    options: { hydra: { type: 'string' } },
    allowPositionals: true,
    strict: false,
  }).positionals.length) {
    return undefined
  }

  return handlers[name as keyof typeof handlers]
}
