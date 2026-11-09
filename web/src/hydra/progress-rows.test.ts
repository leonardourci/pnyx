import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadEntry } from '#hydra/transcripts-read.ts'
import { actionLabel } from './action-label.ts'
import type { PnyxLookup } from './pnyx-action.ts'
import { progressRows } from './progress-rows.ts'

const lookup: PnyxLookup = {
  task: () => undefined,
  column: () => undefined,
}

const trace = ({
  id,
  role,
  text,
  call,
}: {
  id: string
  role: string
  text: string
  call?: string
}): ThreadEntry => ({
  id,
  kind: 'tool',
  role,
  text,
  call,
})

test(
  'a tool call and its result make one row that names the call and keeps the command and output',
  () => {
    const rows = progressRows({
      notes: [
        trace({
          id: 'call',
          role: 'Bash',
          text: '{"command":"gh pr view 12 --json state","description":"Check the pull request"}',
          call: 'toolu_1',
        }),
        {
          id: 'thought',
          kind: 'thinking',
          role: 'assistant',
          text: 'The pull request may have merged.',
        },
        trace({
          id: 'result',
          role: 'tool',
          text: 'MERGED',
          call: 'toolu_1',
        }),
        trace({
          id: 'orphan',
          role: 'tool',
          text: 'late output',
          call: 'toolu_0',
        }),
      ],
    })
    const [
      call,
      thought,
      orphan,
    ] = rows

    assert.equal(
      rows.length,
      3,
    )
    assert.ok(call?.kind === 'tool' && call.call)
    assert.equal(
      call.input,
      'gh pr view 12 --json state',
    )
    assert.equal(
      call.output,
      'MERGED',
    )
    assert.deepEqual(
      actionLabel({
        action: {
          calls: [call.call],
          done: true,
        },
        lookup,
      })?.sentence,
      ['Reading PR #12'],
    )
    assert.equal(
      thought?.kind,
      'thinking',
    )
    assert.ok(orphan?.kind === 'tool' && !orphan.call)
    assert.equal(
      orphan.output,
      'late output',
    )
  },
)
