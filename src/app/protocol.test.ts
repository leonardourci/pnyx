import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLONE_TIMEOUT_MS } from '#projects/limits.ts'
import { ownerOnlyCommand } from './command-registry.ts'
import { commandBytes, MAX_MESSAGE_BYTES, commandTimeout, retryable } from './server-protocol.ts'

test(
  'command transport counts the full envelope and refuses unsafe retries and owner-only writes',
  () => {
    const command = {
      name: 'reply',
      args: [
        'task',
        '',
        'event',
      ],
      id: '0'.repeat(36),
    }
    const room = MAX_MESSAGE_BYTES - commandBytes(command)
    const args = [
      'task',
      'x'.repeat(room),
      'event',
    ]
    assert.equal(
      commandBytes({
        ...command,
        args,
      }),
      MAX_MESSAGE_BYTES,
    )
    assert.equal(
      commandBytes({
        ...command,
        args: [
          ...args.slice(
            0,
            2,
          ),
          'eventx',
        ],
      }),
      MAX_MESSAGE_BYTES + 1,
    )
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
        'rule set': false,
        'account propose': false,
        'account add': false,
        'hydra set --command=x': false,
        'hydra set --helper off': false,
        'project set': false,
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
    const split = {
      name: 'project',
      args: [
        'add',
        '--clone',
        'source',
        '--into',
        '/tmp/cloned',
        '--event-id',
        'attempt',
      ],
    }
    const inline = {
      name: 'project',
      args: [
        'add',
        '--clone=source',
        '--into',
        '/tmp/cloned',
        '--event-id=attempt',
      ],
    }
    assert.equal(
      commandTimeout(split),
      commandTimeout(inline),
    )
    assert.ok(commandTimeout(inline) > CLONE_TIMEOUT_MS)
    assert.equal(
      retryable(split),
      false,
    )
    assert.equal(
      retryable(inline),
      false,
    )
  },
)

test(
  'command size counts UTF-8 and JSON escaping before sending',
  () => {
    for (const text of [
      '界'.repeat(25 * 1024),
      String.fromCharCode(1).repeat(12 * 1024),
    ]) {
      const command = {
        name: 'reply',
        args: [
          'task',
          text,
          'event',
        ],
        id: '0'.repeat(36),
      }
      assert.ok(text.length < MAX_MESSAGE_BYTES)
      assert.ok(commandBytes(command) > MAX_MESSAGE_BYTES)
      assert.equal(
        commandBytes(command),
        Buffer.byteLength(JSON.stringify({
          type: 'command',
          ...command,
        })),
      )
    }
  },
)
