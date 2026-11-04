import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLI_COMMANDS, WORKER_COMMANDS, helperReads, HELPER_TASK_WRITES, ownerOnlyCommand } from './command-registry.ts'
import { commandTimeout, retryable } from './server-protocol.ts'

test(
  'the lists read from the command registry are the ones each caller enforced before',
  () => {
    assert.deepEqual(
      WORKER_COMMANDS,
      [
        'pnyx-axi task show',
        'pnyx-axi task history',
        'pnyx-axi task status',
        'pnyx-axi task chat',
        'pnyx-axi task inbox read',
        'pnyx-axi task inbox ack',
        'pnyx-axi hydra send',
        'pnyx-axi link',
      ],
    )
    assert.deepEqual(
      [...CLI_COMMANDS].sort(),
      [
        'approval',
        'project',
        'task',
        'column',
        'hydra',
        'layout',
        'rule',
        'account',
        'move',
        'link',
        'outcome',
        'undo',
        'view',
        'settings',
        'history',
        'card',
        'integrations',
      ].sort(),
    )
    assert.deepEqual(
      [
        helperReads({ name: 'task' }),
        HELPER_TASK_WRITES,
        helperReads({ name: 'hydra' }),
        helperReads({ name: 'project' }),
        helperReads({ name: 'owner' }),
        helperReads({ name: 'move' }),
      ],
      [
        [
          'list',
          'show',
          'history',
          'chat',
          'sessions',
        ],
        [
          'continue',
          'answer',
          'permission',
        ],
        [
          'check',
          'messages',
          'show',
        ],
        [
          'list',
          'show',
        ],
        ['memory'],
        [],
      ],
    )
    // Command lines Hydra may only propose, and ones it may run.
    const ownerOnly = Object.fromEntries([
      'agent t1 mode',
      'agent t1 model',
      'rule show',
      'rule set',
      'account propose',
      'account add',
      'hydra set --command=x',
      'hydra set --helper off',
      'project set',
      'setup check',
      'setup hooks',
      'task permission $hydra',
      'task copy t1 --discard',
      'task show t1',
      'approval',
      'restart',
      'upgrade --check',
      'upgrade',
      'move t1',
    ].map(line => {
      const [
        name,
        ...args
      ] = line.split(' ')

      return [
        line,
        ownerOnlyCommand({
          name: name!,
          args,
        }),
      ]
    }))
    assert.deepEqual(
      ownerOnly,
      {
        'agent t1 mode': true,
        'agent t1 model': false,
        'rule show': false,
        'rule set': true,
        'account propose': false,
        'account add': true,
        'hydra set --command=x': true,
        'hydra set --helper off': false,
        'project set': true,
        'setup check': false,
        'setup hooks': true,
        'task permission $hydra': true,
        'task copy t1 --discard': true,
        'task show t1': false,
        'approval': true,
        'restart': true,
        'upgrade --check': false,
        'upgrade': true,
        'move t1': false,
      },
    )
    // eslint-disable-next-line pnyx/object-params -- a map callback over plain names.
    const page = (name: string) => [
      commandTimeout({
        name,
        args: [],
      }),
      retryable({
        name,
        args: [],
      }),
    ]
    assert.deepEqual(
      [
        'reply',
        'task-message',
        'answer',
        'agent',
        'hydra-agent',
        'task',
      ].map(page),
      [
        [
          140_000,
          true,
        ],
        [
          140_000,
          true,
        ],
        [
          140_000,
          true,
        ],
        [
          140_000,
          true,
        ],
        [
          60_000,
          true,
        ],
        [
          60_000,
          false,
        ],
      ],
    )
  },
)
