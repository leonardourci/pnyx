import { runFixture } from '#test-harness/child-fixture.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pnyx } from '#test-harness/pnyx.ts'
import { until } from '#test-harness/harness.ts'

test(
  'a restarted Hydra keeps its owner context and receives only the digest changes',
  async t => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'context-probe',
        '--text',
        'SYNTHETIC_OWNER_POLICY',
      ],
    })
    t.after(() => s.owner({
      args: [
        'owner',
        'memory',
        'forget',
        '--key',
        'context-probe',
      ],
    }))
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'unchanged',
        '--title',
        'Unchanged synthetic task',
        '--hold',
      ],
    })
    await s.chat({ text: 'Initial context' })
    const first = await s.agent({ hydra: true })
    await until({
      what: 'the first context turn to finish',
      check: () => first.answered > 0,
    })
    assert.match(
      first.received[0]!,
      /SYNTHETIC_OWNER_POLICY/,
    )
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'changed',
        '--title',
        'New synthetic task',
        '--hold',
      ],
    })
    await pnyx.restart()
    await s.chat({ text: 'Resume with the same session' })
    const resumed = await until({
      what: 'the restarted Hydra to receive context',
      check: () => pnyx.claude.sessions.findLast(agent => agent.id === first.id && agent !== first && agent.received.some(text => text.includes('Resume with the same session'))),
    })
    assert.equal(
      resumed.resumed,
      true,
    )
    assert.match(
      resumed.received[0]!,
      /New synthetic task/,
    )
    assert.doesNotMatch(
      resumed.received[0]!,
      /SYNTHETIC_OWNER_POLICY|Unchanged synthetic task/,
    )
  },
)

test(
  'a hosted Hydra compacts at the context limit without repeating stale usage',
  async t => {
    const stdout = await runFixture({
      t,
      name: 'context-compaction',
    })
    assert.match(
      stdout,
      /Context compacts at the limit and does not loop/,
    )
  },
)
