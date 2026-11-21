import { parseArgs } from 'node:util'

const VALUE_FLAGS = [
  'hydra',
  'actor',
  'reason',
  'details',
  'event-id',
  'if-revision',
  'confirm',
  'title',
  'brief',
  'project',
  'ask',
  'intent',
  'message',
  'key',
  'harness',
  'account',
  'model',
  'effort',
  'mode',
  'fast',
  'rule',
  'folder',
  'task',
  'text',
  'file',
  'idempotency-key',
  'from-message',
  'choice',
  'port',
  'url',
  'limit',
  'cwd',
  'card',
  'kind',
  'workspace',
  'before',
  'after',
  'budget',
  'cursor',
  'since',
  'through',
  'session',
  'wait',
  'fields',
  'home',
  'column',
  'direction',
  'from',
  'to',
  'at',
  'id',
  'operation',
  'until',
  'batch',
]

export function cliArguments({ argv }: { argv: string[] }) {
  const {
    tokens,
  } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    tokens: true,
    options: {
      ...Object.fromEntries(VALUE_FLAGS.map(name => [
        name,
        { type: 'string' as const },
      ])),
      json: { type: 'boolean' },
      help: {
        type: 'boolean',
        short: 'h',
      },
      version: {
        type: 'boolean',
        short: 'v',
      },
    },
  })
  const switches = tokens.filter(token => token.kind === 'option' && [
    '--json',
    '--help',
    '-h',
    '--version',
    '-v',
  ].includes(argv[token.index] ?? ''))
  const indexes = new Set(switches.map(token => token.index))

  return {
    tokens,
    argv: argv.filter((
      _,
      index,
    ) => !indexes.has(index)),
    json: switches.some(token => token.kind === 'option' && token.name === 'json'),
    help: switches.some(token => token.kind === 'option' && token.name === 'help'),
    version: switches.some(token => token.kind === 'option' && token.name === 'version'),
  }
}
