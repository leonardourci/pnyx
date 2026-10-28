import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandBytes, MAX_MESSAGE_BYTES } from './server-protocol.ts'

test(
  'command size includes the complete serialized envelope at the transport boundary',
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
