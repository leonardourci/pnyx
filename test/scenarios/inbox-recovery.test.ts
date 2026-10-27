import assert from 'node:assert/strict'
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { followUpSteering, STEERING_GRACE_MS, STEERING_RING_LIMIT } from '../../src/task-inbox/follow-up.ts'
import { steeringNotice } from '../../src/task-inbox/notice.ts'
import { enqueueSteering } from '../../src/task-inbox/inbox.ts'
import { withWriter } from '../../src/store/hydra-store.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'a delivered but unread instruction is re-rung within durable bounds and wakes Hydra once across restart',
  async () => {
    const s = await pnyx.scenario()
    const hydra = await s.chat({ text: 'Supervise the worker' })
    const folder = s.folder({ name: 'worker' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Work',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'work',
      ],
    })
    await s.agent({ cwd: folder })
    const card = () => s.task({ key: 'work' })
    await until({
      what: 'worker idle',
      check: () => card().sessionActivity === 'finished',
    })
    await s.owner({
      args: [
        'reply',
        'work',
        '--idempotency-key',
        'unread',
        '--text',
        'Olá 🌊\nKeep this instruction',
      ],
    })
    const notice = steeringNotice({
      task: card().id,
      hydraId: s.hydraId,
      ids: ['unread'],
    })
    await until({
      what: 'initial notice consumed',
      check: () => s.received({ cwd: folder }).includes(notice),
    })
    assert.equal(
      card().steering![0]!.ack,
      undefined,
    )
    const queuedAt = Date.parse(card().steering![0]!.at)

    for (let tick = 1; tick <= STEERING_RING_LIMIT; tick++) {
      await followUpSteering({
        hydraId: s.hydraId,
        now: queuedAt + tick * STEERING_GRACE_MS,
      })
      const attempts = card().steering![0]!.recovery!
      assert.equal(
        attempts.length,
        tick,
      )
      assert.equal(
        attempts.at(-1)!.result,
        'delivered',
      )

      if (tick === 1) {
        await pnyx.restart()
      }
    }

    await followUpSteering({
      hydraId: s.hydraId,
      now: queuedAt + (STEERING_RING_LIMIT + 1) * STEERING_GRACE_MS,
    })
    await until({
      what: 'Hydra receives the actionable unread instruction',
      check: () => s.received({ cwd: hydra.cwd }).some(text => text.includes('instruction unread') && text.includes('unread')),
    })
    await pnyx.restart()
    await followUpSteering({
      hydraId: s.hydraId,
      now: queuedAt + 100 * STEERING_GRACE_MS,
    })
    const message = card().steering![0]!
    assert.equal(
      message.recovery!.filter(attempt => attempt.result === 'exhausted').length,
      1,
    )
    assert.equal(
      message.recovery!.length,
      STEERING_RING_LIMIT + 1,
    )
    assert.equal(
      message.text,
      'Olá 🌊\nKeep this instruction',
    )
    assert.equal(
      message.ack,
      undefined,
    )
    assert.equal(
      card().replies!.filter(reply => reply.id.includes('~retry')).length,
      0,
    )
    const current = await s.agent({ cwd: folder })
    await s.as({ agent: current }).run({
      args: [
        'task',
        'inbox',
        'ack',
        'work',
        'unread',
        '--session',
        card().sessionIds![0]!,
        '--generation',
        String(card().steeringGeneration),
      ],
    })
    assert.equal(
      card().steering![0]!.ack!.outcome,
      'incorporated',
    )
  },
)

test(
  'terminal instructions persist before a short doorbell and a human draft is left intact',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'native-worker' })
    const bin = s.folder({ name: 'terminal-bin' })
    const stub = s.folder({ name: 'terminal-state' })
    const fixture = join(
      import.meta.dirname,
      '..',
      'fixtures',
      'hosts',
      'inbox-terminal.sh',
    )
    symlinkSync(
      fixture,
      join(
        bin,
        'ps',
      ),
    )
    symlinkSync(
      fixture,
      join(
        bin,
        'tmux',
      ),
    )
    writeFileSync(
      join(
        stub,
        'composer',
      ),
      'history\n❯ human draft\n',
    )
    const savedPath = process.env.PATH
    const savedStub = process.env.STUB_DIR
    process.env.PATH = `${bin}:${savedPath}`
    process.env.STUB_DIR = stub

    try {
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'native',
          '--title',
          'Native',
          '--folder',
          folder,
        ],
      })
      await s.owner({
        args: [
          'push',
          '--key',
          'native-session',
          '--file',
          '-',
        ],
        input: JSON.stringify({
          agent: {
            provider: 'claude-code',
            sessionId: 'native-session',
            cwd: folder,
          },
          activity: 'finished',
          terminal: {
            tty: '/dev/ttys042',
            pid: '4242',
            tmux: '/tmp/fixture.sock',
            tmuxPane: '%1',
          },
        }),
      })
      await s.owner({
        args: [
          'task',
          'attach',
          'native',
          '--session',
          'claude-code:native-session',
        ],
      })
      const card = () => s.task({ key: 'native' })
      const prefix = 'Shared prefix '.repeat(30)
      await s.owner({
        args: [
          'reply',
          'native',
          '--idempotency-key',
          'drafted',
          '--text',
          `${prefix}\nOlá 🌊`,
        ],
      })
      assert.equal(
        existsSync(join(
          stub,
          'notices',
        )),
        false,
      )
      assert.equal(
        card().steering![0]!.attempts[0]!.result,
        'deferred',
      )
      assert.equal(
        card().steering![0]!.text,
        `${prefix}\nOlá 🌊`,
      )
      writeFileSync(
        join(
          stub,
          'composer',
        ),
        'history\n❯ \n',
      )
      const queuedAt = Date.parse(card().steering![0]!.at)
      await followUpSteering({
        hydraId: s.hydraId,
        now: queuedAt + STEERING_GRACE_MS,
      })
      const sent = readFileSync(
        join(
          stub,
          'notices',
        ),
        'utf8',
      )
      assert.equal(
        sent,
        steeringNotice({
          task: card().id,
          hydraId: s.hydraId,
          ids: ['drafted'],
        }),
      )
      assert.equal(
        sent.includes(prefix),
        false,
      )
      assert.equal(
        card().steering![0]!.ack,
        undefined,
      )
      assert.equal(
        card().steering![0]!.recovery![0]!.result,
        'delivered',
      )
      await pnyx.restart()
      assert.equal(
        card().steering![0]!.recovery!.length,
        1,
      )
    } finally {
      process.env.PATH = savedPath

      if (savedStub === undefined) {
        delete process.env.STUB_DIR
      } else {
        process.env.STUB_DIR = savedStub
      }
    }
  },
)

test(
  'the server schedules durable recovery itself for an aged instruction after restart',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'scheduled-worker' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'scheduled',
        '--title',
        'Scheduled',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'scheduled',
      ],
    })
    await s.agent({ cwd: folder })
    await until({
      what: 'worker idle',
      check: () => s.task({ key: 'scheduled' }).sessionActivity === 'finished',
    })
    const card = s.task({ key: 'scheduled' })
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => enqueueSteering({
        writer,
        ref: card.id,
        id: 'aged',
        text: 'Read this after recovery',
        source: 'test',
        meta: {
          actor: 'test',
          at: new Date(Date.now() - STEERING_GRACE_MS).toISOString(),
        },
      }),
    })
    await pnyx.restart()
    await until({
      what: 'the server persists its own recovery notification',
      check: () => s.task({ key: 'scheduled' }).steering![0]!.recovery?.some(attempt => attempt.result === 'delivered'),
    })
    assert.ok(s.received({ cwd: folder }).includes(steeringNotice({
      task: card.id,
      hydraId: s.hydraId,
      ids: ['aged'],
    })))
    assert.equal(
      s.task({ key: 'scheduled' }).steering![0]!.ack,
      undefined,
    )
  },
)
