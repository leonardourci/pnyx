import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invocationOf } from './run.ts'

test(
  'a command line is named after its subcommand only when its usage spells that word out, never after an id it takes',
  () => {
    assert.deepEqual(
      [
        [
          'card',
          'synthetic-task',
        ],
        [
          'move',
          'synthetic-task',
          'done',
        ],
        [
          'undo',
          'synthetic-event',
        ],
        [
          'agent',
          'synthetic-task',
        ],
        [
          'task',
          'show',
          'synthetic-task',
        ],
        [
          'task',
          'unhide',
          'synthetic-task',
        ],
        [
          'debug',
          'performance',
        ],
        [
          'logs',
          'clean',
        ],
        [
          'upgrade',
          '--check',
        ],
      ].map(argv => invocationOf({ argv }).name),
      [
        'card',
        'move',
        'undo',
        'agent',
        'task show',
        'task unhide',
        'debug performance',
        'logs clean',
        'upgrade',
      ],
    )
    assert.match(
      invocationOf({
        argv: [
          'card',
          'synthetic-task',
        ],
      }).focused ?? '',
      /^usage: pnyx-axi card <id\|key>/,
      'an id still focuses the help on the usage that takes it',
    )
  },
)
