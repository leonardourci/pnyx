import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { runFixture } from '#test-harness/child-fixture.ts'
import { until } from '#test-harness/harness.ts'
import { pnyx, type Scenario } from '#test-harness/pnyx.ts'

const HELD = 'Held while compacting'

// Claude Code sends `compacting` when a compaction starts and again every 30 seconds while it runs, each under a new uuid.
const compacting = (): SDKMessage => ({
  type: 'system',
  subtype: 'status',
  status: 'compacting',
  uuid: randomUUID(),
  session_id: '',
})

const compacted = (): SDKMessage => ({
  type: 'system',
  subtype: 'status',
  status: null,
  compact_result: 'success',
  uuid: randomUUID(),
  session_id: '',
})

// Sends /compact to a Hydra that has answered once, holds it after `before` while the owner sends a message, and returns the operations once that message reaches Hydra.
async function compact({
  s,
  before,
  after,
}: {
  s: Scenario
  before: SDKMessage[]
  after: SDKMessage[]
}) {
  await s.chat({ text: 'Ready to compact' })
  const agent = await s.agent({ hydra: true })
  await until({
    what: 'Hydra to finish its first turn',
    check: () => s.answered({ cwd: agent.cwd }) === 1 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  const turn = pnyx.claude.plan({
    text: '/compact',
    hold: true,
    before,
    after,
  })

  try {
    await s.chat({ text: '/compact' })
    await until({
      what: 'the compaction to run',
      check: () => s.state().cards[HYDRA_CARD]?.compaction?.operations.some(operation => operation.state === 'running'),
    })
    await s.owner({
      args: [
        'hydra',
        'send',
        '--text',
        HELD,
      ],
    })
    await until({
      what: 'the owner’s message to wait for the compaction',
      check: () => s.state().cards[HYDRA_CARD]?.compaction?.inputs
        .some(input => input.text.includes(HELD)),
    })
  } finally {
    turn.release()
  }

  await until({
    what: 'the held message to reach Hydra after the compaction',
    check: () => s.received({ cwd: agent.cwd }).some(text => text.includes(HELD))
      && !s.state().cards[HYDRA_CARD]?.compaction?.inputs.length,
  })

  return s.state().cards[HYDRA_CARD]!.compaction!.operations
}

test(
  'a long manual /compact stays one operation through Claude Code’s repeated statuses, and its result releases held input',
  async () => {
    const s = await pnyx.scenario()
    const operations = await compact({
      s,
      before: [compacting()],
      after: [
        compacting(),
        compacting(),
        compacted(),
      ],
    })
    assert.deepEqual(
      operations.map(({
        trigger,
        state,
      }) => ({
        trigger,
        state,
      })),
      [
        {
          trigger: 'manual',
          state: 'done',
        },
      ],
    )
  },
)

test(
  'a compaction that leads straight into another shows them one after the other, and held input waits for the last',
  async () => {
    const s = await pnyx.scenario()
    const operations = await compact({
      s,
      before: [compacting()],
      after: [
        compacted(),
        compacting(),
        compacting(),
        compacted(),
      ],
    })
    assert.deepEqual(
      operations.map(({
        trigger,
        state,
      }) => ({
        trigger,
        state,
      })),
      [
        {
          trigger: 'manual',
          state: 'done',
        },
        {
          trigger: 'auto',
          state: 'done',
        },
      ],
    )
    const changes = s.events().flatMap(event => event.type === 'session.compaction' ? [event.data] : [])
    assert.ok(
      changes.findLastIndex(change => change.kind === 'status' && change.operation.state === 'done')
        < changes.findIndex(change => change.kind === 'taken'),
      'the held message is taken only after the second compaction ends',
    )
  },
)

test(
  'a compaction its agent stops reporting, or never answers, fails at its deadline and releases held input',
  async t => {
    assert.match(
      await runFixture({
        t,
        name: 'compaction-deadline',
      }),
      /Silent and unanswered compactions failed at their deadline and released held input/,
    )
  },
)
