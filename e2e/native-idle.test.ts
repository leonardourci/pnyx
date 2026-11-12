import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pnyx } from '#test-harness/pnyx.ts'
import { until } from '#test-harness/harness.ts'
import { runFixture } from '#test-harness/child-fixture.ts'

test(
  'application idle cleanup waits for native queued, background and unknown work',
  async t => {
    const stdout = await runFixture({
      t,
      name: 'native-idle',
    })
    assert.match(
      stdout,
      /Native cleanup waited for queued, background and unknown work/,
    )
  },
)

test(
  'copy release rechecks work committed while its worker closes',
  async t => {
    const stdout = await runFixture({
      t,
      name: 'copy-release',
    })
    assert.match(
      stdout,
      /Copy release rechecked final background work before removal/,
    )
  },
)

test(
  'copy removal through the CLI permanently releases a working hosted session',
  async () => {
    const s = await pnyx.scenario()
    const project = await s.project({ name: 'release-cli' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'release-cli',
        '--title',
        'Release CLI',
        '--project',
        project,
      ],
    })
    const task = s.task({ key: 'release-cli' })
    const held = pnyx.claude.plan({
      match: ({ text }) => text.includes(`<pnyx-worker task="${task.id}"`),
      hold: true,
    })

    try {
      await s.owner({
        args: [
          'task',
          'start',
          task.id,
          '--harness',
          'claude',
          '--reason',
          'Exercise permanent copy release',
        ],
      })
      const active = s.task({ key: 'release-cli' })
      assert.ok(active.copy)
      const agent = await s.agent({ cwd: active.copy.path })
      assert.equal(
        s.task({ key: 'release-cli' }).sessionActivity,
        'working',
      )
      await s.owner({
        args: [
          'task',
          'copy',
          task.id,
          'remove',
          '--safe',
        ],
      })
      assert.equal(
        s.task({ key: 'release-cli' }).copy?.state,
        'removed',
      )
      await until({
        what: 'permanently released worker closes',
        check: () => agent.closed,
      })
    } finally {
      held.release()
    }
  },
)
