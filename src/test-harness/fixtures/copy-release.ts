import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { hostRequest } from '#app/host-request.ts'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commands } from '#app/cli.ts'
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

for (const mode of [
  'check',
  'safe',
] as const) {
  const project = join(
    process.env.HOME,
    `project-${mode}`,
  )
  const folder = join(
    process.env.HOME,
    `copy-${mode}`,
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
  const ready = join(
    process.env.HOME,
    `${mode}-ready`,
  )
  const committed = join(
    process.env.HOME,
    `${mode}-committed`,
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

    if (request.options.persistSession !== false) {
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

    return worker.query(request)
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
            key: mode,
            title: 'Copy release',
          },
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in created)
        writer.append({ event: created.event })
        const task = writer.state.keys[mode]!
        const attached = decidePush({
          state: writer.state,
          key: mode,
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: mode,
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
      inputId: mode,
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

    if (mode === 'check') {
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
        'flagged',
      )
      assert.equal(
        outcome.result.check?.landed,
        false,
      )
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
      true,
      'the final unlanded commit keeps its copy',
    )
    assert.notEqual(
      git({
        cwd: folder,
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
