import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
      const copy = active.copy
      const agent = await s.agent({ cwd: copy.path })
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
      assert.equal(
        existsSync(copy.path),
        true,
        'the released copy is pooled',
      )
      const opened = pnyx.claude.sessions.filter(session => session.cwd === copy.path).length
      const receipt = await s.owner({
        args: [
          'reply',
          task.id,
          '--text',
          'Reply after copy release',
        ],
      })
      assert.match(
        receipt,
        /^ +state: failed$/m,
      )
      assert.equal(
        pnyx.claude.sessions.filter(session => session.cwd === copy.path).length,
        opened,
      )
      assert.ok(s.task({ key: 'release-cli' }).steering?.some(message => message.text.includes('Reply after copy release')))
    } finally {
      held.release()
    }
  },
)

test(
  'a worker that declares its own task done finishes that turn, and a later reply resumes it',
  async () => {
    const s = await pnyx.scenario()
    const project = await s.project({ name: 'self-done' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'self-done',
        '--title',
        'Self done',
        '--project',
        project,
      ],
    })
    const task = s.task({ key: 'self-done' })
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
          'Exercise a worker closing its own task',
        ],
      })
      const copy = s.task({ key: 'self-done' }).copy
      assert.ok(copy)
      const agent = await s.agent({ cwd: copy.path })
      await s.as({ agent }).run({
        args: [
          'task',
          'status',
          task.id,
          'done',
          '--note',
          'Finished',
        ],
      })
      // Work left after the declaration keeps the copy, so the reply below has a folder to resume in.
      writeFileSync(
        join(
          copy.path,
          'unlanded.txt',
        ),
        'work',
      )
      await s.owner({
        args: [
          'task',
          'show',
          task.id,
        ],
      })
      assert.equal(
        agent.closed,
        undefined,
        'the worker finishes the turn that declared its task done',
      )
      held.release()
      await until({
        what: 'worker reaped after its turn',
        check: () => agent.closed === true,
      })
      assert.equal(
        s.task({ key: 'self-done' }).sessionActivity,
        'finished',
      )
      await s.owner({
        args: [
          'reply',
          task.id,
          '--text',
          'Follow-up after done',
        ],
      })
      const resumed = () => pnyx.claude.sessions.find(session => session !== agent
        && session.received.some(text => text.includes('Follow-up after done')))
      await until({
        what: 'reply to the done task answered',
        check: () => (resumed()?.answered ?? 0) > 0,
      })
      assert.equal(
        resumed()?.cwd,
        copy.path,
      )
      await until({
        what: 'resumed worker reaped after its turn',
        check: () => resumed()?.closed === true,
      })
    } finally {
      held.release()
    }
  },
)
