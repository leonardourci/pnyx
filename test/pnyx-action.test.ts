import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadEntry } from '../src/thread/read.ts'
import { pnyxCalls, pnyxSentence, pnyxWords, shellCommand, type PnyxLookup } from '../web/src/hydra/pnyx-action.ts'

const lookup: PnyxLookup = {
  task: ({ ref }) => ref === 'login' || ref === 'task-1' ? {
    id: 'task-1',
    title: 'Fix login loop',
  } : undefined,
  column: ({ ref }) => ref === 'needs_you' ? 'Needs you' : undefined,
}

const sentence = ({
  command,
  output,
}: {
  command: string
  output?: string
}) => pnyxSentence({
  words: pnyxWords({ command })!,
  output,
  lookup,
})

test(
  'a Pnyx command reads as what it did, with its task as a chip',
  () => {
    const chip = {
      task: 'task-1',
      label: 'Fix login loop',
    }
    assert.deepEqual(
      sentence({ command: 'PNYX_ACTOR=hydra pnyx-axi move login needs_you --reason "its agent asked which schema" --confirm abc --hydra default' }),
      [
        'Moved ',
        chip,
        ' to Needs you: its agent asked which schema',
      ],
    )
    assert.deepEqual(
      sentence({
        command: 'pnyx-axi move login needs_you --reason x',
        output: 'confirmation: needed\ntoken: abc',
      })[0],
      'Asked to confirm moving ',
    )
    assert.deepEqual(
      sentence({
        command: 'pnyx-axi task create --title "Fix login loop" --brief "Fix it" --reason "owner asked"',
        output: 'event:\n  seq: 2\ncard:\n  id: task-1\n  column: queued',
      }),
      [
        'Created ',
        chip,
        ': owner asked',
      ],
    )
    assert.deepEqual(
      sentence({ command: 'pnyx-axi reply task-1 --text \'Use the v2 schema.\nThen rerun the tests.\'' }),
      [
        'Sent ',
        chip,
        '’s worker: Use the v2 schema.',
      ],
    )
    assert.deepEqual(
      sentence({ command: 'pnyx-axi task start login --harness codex && pnyx-axi hydra check' }),
      [
        'Started a worker on ',
        chip,
        ' with Codex',
      ],
    )
    assert.deepEqual(
      sentence({ command: 'pnyx-axi task status login needs_you --note "Which schema?"' }),
      [
        'Marked ',
        chip,
        ' needs you: Which schema?',
      ],
    )
    assert.deepEqual(
      sentence({ command: 'pnyx-axi hydra memory set --key scope --text "Billing only"' }),
      ['Saved Hydra memory “scope”'],
    )
    assert.deepEqual(
      sentence({ command: 'pnyx-axi rule propose --name fast' }),
      ['Pnyx: rule propose'],
    )
  },
)

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

test(
  'a Pnyx call absorbs its result and the chat line it posted',
  () => {
    const entries: ThreadEntry[] = [
      {
        id: 'ask',
        kind: 'tool',
        role: 'Bash',
        call: 'toolu_0',
        text: '{"command":"pnyx-axi move login needs_you --reason \\"its agent asked\\""}',
      },
      {
        id: 'ask-result',
        kind: 'tool',
        role: 'tool',
        call: 'toolu_0',
        text: 'confirmation: needed\ntoken: abc',
      },
      {
        id: 'move',
        kind: 'tool',
        role: 'Bash',
        call: 'toolu_1',
        text: '{"command":"pnyx-axi move login needs_you --reason \\"its agent asked\\" --confirm abc"}',
        at: '2026-10-21T10:00:00Z',
      },
      {
        id: 'posted',
        kind: 'message',
        role: 'assistant',
        text: 'Moved Fix login loop to Needs you: its agent asked',
        at: '2026-10-21T10:00:01Z',
      },
      {
        id: 'result',
        kind: 'tool',
        role: 'tool',
        call: 'toolu_1',
        text: JSON.stringify([
          {
            type: 'text',
            text: 'event:\n  seq: 9\nposted: "Moved Fix login loop to Needs you: its agent asked"',
          },
        ]),
        at: '2026-10-21T10:00:02Z',
      },
      {
        id: 'missing',
        kind: 'tool',
        role: 'Bash',
        call: 'toolu_2',
        text: '{"command":"pnyx-axi task show nope"}',
      },
      {
        id: 'missing-result',
        kind: 'tool',
        role: 'tool',
        call: 'toolu_2',
        text: 'error: "card not found: nope"\ncode: NOT_FOUND',
      },
      {
        id: 'shell',
        kind: 'tool',
        role: 'Bash',
        call: 'toolu_3',
        text: '{"command":"git status"}',
      },
      {
        id: 'shell-result',
        kind: 'tool',
        role: 'tool',
        call: 'toolu_3',
        text: 'clean',
      },
    ]
    const {
      entries: kept,
      calls,
    } = pnyxCalls({
      entries,
      lookup,
    })
    assert.deepEqual(
      kept.map(entry => entry.id),
      [
        'move',
        'missing',
        'shell',
        'shell-result',
      ],
    )
    assert.equal(
      calls.get('move')?.command,
      'pnyx-axi move login needs_you --reason "its agent asked" --confirm abc',
    )
    assert.equal(
      calls.get('missing')?.failed,
      'card not found: nope',
    )
    assert.equal(
      calls.has('shell'),
      false,
    )
  },
)
