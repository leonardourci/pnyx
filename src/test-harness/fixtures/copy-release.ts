import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { hostRequest } from '#app/host-request.ts'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commands } from '#app/cli.ts'
import { reply } from '#workers/reply-cli.ts'
import { createHost } from '#app/host.ts'
import { offerHost } from '#app/server-state.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { settleCopy } from '#projects/copy-settle.ts'
import { decidePush } from '#tasks/push.ts'
import { planTaskChange } from '#tasks/plans.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import type { QueryFn } from '#workers/claude.ts'
import { settle } from '#test-harness/child-fixture.ts'
import { git } from '#test-harness/harness.ts'

const hydraId = 'copy-release-fixture'
commands.hydra([
  'create',
  hydraId,
])
assert.ok(process.env.HOME)

for (const ending of [
  'check',
  'safe',
  'removed',
] as const) {
  const mode = ending === 'removed' ? 'check' : ending
  const project = join(
    process.env.HOME,
    `project-${ending}`,
  )
  const folder = join(
    process.env.HOME,
    `copy-${ending}`,
  )
  mkdirSync(project)
  git({
    cwd: project,
    args: [
      'init',
      '-q',
      '-b',
      'main',
    ],
  })
  git({
    cwd: project,
    args: [
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'Base',
    ],
  })
  git({
    cwd: project,
    args: [
      'worktree',
      'add',
      '-q',
      '-b',
      'worker',
      folder,
    ],
  })
  const before = git({
    cwd: folder,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })
  const worker = claudeNative()
  const workers: ReturnType<typeof claudeNative>[] = []
  const ready = join(
    process.env.HOME,
    `${ending}-ready`,
  )
  const committed = join(
    process.env.HOME,
    `${ending}-committed`,
  )
  let child: ChildProcess | undefined
  git({
    cwd: project,
    args: [
      'config',
      'user.name',
      'Test',
    ],
  })
  git({
    cwd: project,
    args: [
      'config',
      'user.email',
      'test@example.com',
    ],
  })

  const query: QueryFn = ({ ...request }) => {
    assert.ok(request.options)

    if (request.options.persistSession === false) {
      return worker.query(request)
    }

    const current = workers.length ? claudeNative() : worker
    workers.push(current)

    if (workers.length > 1) {
      const state = loadHydra({ hydraId }).state
      const saved = state.cards[state.keys[ending]!]
      assert.equal(
        saved?.copy?.state,
        mode === 'safe' ? 'active' : 'flagged',
      )
    }

    if (workers.length === 1) {
      assert.ok(request.options.spawnClaudeCodeProcess)
      const spawned = request.options.spawnClaudeCodeProcess({
        command: process.execPath,
        args: [
          '-e',
          `
          const { writeFileSync } = require('node:fs');
          const { execFileSync } = require('node:child_process');
          process.on('SIGTERM', () => {
            execFileSync('git', ['-C', ${JSON.stringify(folder)}, 'commit', '-q', '--allow-empty', '-m', 'Final background work']);
            if (${ending === 'removed'}) {
              execFileSync('git', ['-C', ${JSON.stringify(project)}, 'merge', '--ff-only', 'worker']);
            }
            writeFileSync(${JSON.stringify(committed)}, '');
          });
          process.stdin.once('data', () => process.exit(0));
          writeFileSync(${JSON.stringify(ready)}, '');
        `,
        ],
        cwd: folder,
        env: process.env,
        signal: new AbortController().signal,
      })
      assert.ok(spawned instanceof ChildProcess)
      child = spawned
    }

    return current.query(request)
  }

  const host = createHost({
    hydraId,
    query,
    changed: () => {},
  })
  const offer = () => offerHost({
    hydraId,
    ask: ({ body }) => hostRequest({
      host,
      body,
    }),
  })
  let stopOffering = offer()

  try {
    const task = withWriter({
      hydraId,
      fn: ({ writer }) => {
        const created = planTaskChange({
          hydraId,
          landing: new Map(),
          state: writer.state,
          operation: {
            op: 'task.create',
            key: ending,
            title: 'Copy release',
          },
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in created)
        writer.append({ event: created.event })
        const task = writer.state.keys[ending]!
        const attached = decidePush({
          state: writer.state,
          key: ending,
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: ending,
              host: 'pnyx',
              cwd: folder,
            },
          },
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in attached)
        writer.append({ event: attached.event })
        const copied = hydraEvent({
          state: writer.state,
          cardId: task,
          change: {
            type: 'task.copy',
            data: {
              before: null,
              after: {
                path: folder,
                project,
                via: 'worktree',
                base: 'main',
                branch: 'worker',
                state: 'active',
              },
            },
          },
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in copied)
        writer.append({ event: copied.event })

        return task
      },
    })
    host.send({
      card: task,
      text: 'Work',
      actor: 'cli',
      direct: true,
      inputId: ending,
    })
    await settle({
      what: 'copy worker input',
      check: () => worker.incoming.length === 1,
    })
    const release = () => settleCopy({
      hydraId,
      ref: task,
      mode,
      meta: {
        actor: 'cli',
        at: new Date().toISOString(),
      },
    })

    await settle({
      what: 'child is ready for cleanup',
      check: () => existsSync(ready),
    })
    assert.ok(child)

    if (ending === 'check') {
      stopOffering()
      await assert.rejects(
        release,
        { code: 'NOT_RUNNING' },
      )
      assert.equal(
        existsSync(folder),
        true,
      )
      assert.equal(
        loadHydra({ hydraId }).state.cards[task]?.copy?.state,
        'active',
      )
      assert.equal(
        worker.closed(),
        false,
      )
      stopOffering = offer()
    }

    if (mode === 'safe') {
      const dirty = join(
        folder,
        'dirty',
      )
      writeFileSync(
        dirty,
        'uncommitted',
      )
      await assert.rejects(
        release,
        { code: 'CONFLICT' },
      )
      assert.equal(
        worker.closed(),
        false,
        'unsafe work is refused before releasing the worker',
      )
      unlinkSync(dirty)
    }

    let finished = false
    const settlement = release()
    const observed = (async () => {
      try {
        return { result: await settlement }
      } catch (error) {
        return { error }
      } finally {
        finished = true
      }
    })()
    await settle({
      what: 'final commit while cleanup waits',
      check: () => existsSync(committed),
    })
    assert.equal(
      finished,
      false,
      'settlement waits for the task-owned group',
    )
    assert.equal(
      existsSync(folder),
      true,
    )
    assert.equal(
      loadHydra({ hydraId }).state.cards[task]?.copy?.state,
      'active',
    )

    const instructions = [
      'First owner instruction',
      'Second owner instruction',
    ]

    for (const text of instructions) {
      const output = await reply([
        task,
        '--text',
        text,
        '--hydra',
        hydraId,
      ])
      const receipt = output.reply
      assert.ok(receipt && typeof receipt === 'object' && 'state' in receipt)
      assert.equal(
        receipt.state,
        'queued',
      )
    }

    assert.equal(
      workers.length,
      1,
      'owner replies cannot reopen the session during settlement',
    )
    assert.equal(
      loadHydra({ hydraId }).state.cards[task]?.steering?.filter(message => !message.ack).length,
      2,
    )
    await assert.rejects(
      async () => commands.task([
        'start',
        task,
        '--harness',
        'claude',
        '--hydra',
        hydraId,
      ]),
      { code: 'CONFLICT' },
    )
    const controlOutput = await reply([
      task,
      '--text',
      '/compact',
      '--hydra',
      hydraId,
    ])
    const control = controlOutput.reply
    assert.ok(control && typeof control === 'object' && 'state' in control && 'detail' in control)
    assert.equal(
      control.state,
      'failed',
    )
    assert.match(
      String(control.detail),
      /copy.*try again/i,
    )
    await assert.rejects(
      () => hostRequest({
        host,
        body: {
          action: 'send',
          card: task,
          direct: true,
          text: '/compact',
          actor: 'cli',
        },
      }),
      { code: 'CONFLICT' },
    )
    assert.ok(child.stdin)
    child.stdin.end('finish')
    const outcome = await observed

    if (mode === 'safe') {
      assert.ok('error' in outcome && outcome.error instanceof Error)
      assert.equal(
        'code' in outcome.error && outcome.error.code,
        'CONFLICT',
      )
      assert.equal(
        loadHydra({ hydraId }).state.cards[task]?.copy?.state,
        'active',
      )
    } else {
      assert.ok(outcome.result)
      assert.equal(
        outcome.result.copy?.state,
        ending === 'removed' ? 'removed' : 'flagged',
      )
      assert.equal(
        outcome.result.check?.landed,
        ending === 'removed',
      )
    }

    if (ending === 'removed') {
      await settle({
        what: 'queued messages use the missing-copy path after removal',
        check: () => {
          const pending = loadHydra({ hydraId }).state.cards[task]?.steering

          return pending?.every(message => message.attempts.length > 0)
        },
      })
      assert.equal(
        workers.length,
        1,
        'a removed copy cannot start another session',
      )
      assert.equal(
        loadHydra({ hydraId }).state.cards[task]?.steering?.filter(message => !message.ack).length,
        2,
      )
    } else {
      await settle({
        what: 'queued replies resume after saved copy state',
        check: () => workers.length === 2 && (workers[1]?.incoming.length ?? 0) > 0,
      })
      await settle({
        what: 'both queued replies are taken once',
        check: () => instructions.every(text => workers[1]?.incoming.some(message => {
          return JSON.stringify(message.message.content).includes(text)
        })),
      })
      const resumed = workers[1]
      assert.ok(resumed)
      const received = resumed.incoming.map(message => JSON.stringify(message.message.content)).join('\n')

      for (const text of instructions) {
        assert.equal(
          received.split(text).length - 1,
          1,
        )
      }
    }

    assert.equal(
      worker.closed(),
      true,
    )
    assert.equal(
      existsSync(committed),
      true,
    )
    assert.equal(
      existsSync(folder),
      ending !== 'removed',
      'only the landed final commit can release its copy',
    )
    assert.notEqual(
      git({
        cwd: ending === 'removed' ? project : folder,
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
      before,
    )
  } finally {
    child?.kill('SIGKILL')
    stopOffering()
    host.close()
  }
}

console.log('Copy release rechecked final background work before removal')
