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
  'message',
  'batch',
]

export function cliArguments({ argv }: { argv: string[] }) {
  const {
    values,
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
    'json',
    'help',
    'version',
  ].includes(token.name))
  const indexes = new Set(switches.map(token => token.index))

  return {
    argv: argv.filter((
      _,
      index,
    ) => !indexes.has(index)),
    json: values.json === true,
    help: values.help === true,
    version: values.version === true,
  }
}
