import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pnyxWords,shellCommand } from './pnyx-action.ts'

test(
  'only pnyx-axi itself counts as a Pnyx command',
  () => {
    assert.equal(
      shellCommand({ text: '{"command":"pnyx-axi hydra digest","description":"Read"}' }),
      'pnyx-axi hydra digest',
    )
    assert.equal(
      shellCommand({ text: '{"command":["bash","-lc","pnyx-axi task list"]}' }),
      'pnyx-axi task list',
    )
    assert.deepEqual(
      pnyxWords({ command: 'node /repo/src/cli/pnyx-axi.ts task list' }),
      [
        'task',
        'list',
      ],
    )
    assert.equal(
      pnyxWords({ command: 'echo pnyx-axi task list' }),
      undefined,
    )
    assert.equal(
      pnyxWords({ command: 'git log' }),
      undefined,
    )
  },
)
