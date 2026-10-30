import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLONE_TIMEOUT_MS } from '#projects/limits.ts'
import { commandTimeout, retryable } from './server-protocol.ts'

test(
  'both clone flag forms outlast git and remain excluded from automatic retry',
  () => {
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
