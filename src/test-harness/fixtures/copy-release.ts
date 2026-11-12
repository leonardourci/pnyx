import assert from 'node:assert/strict'
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
  let committed = false

  const query: QueryFn = ({ ...request }) => {
    assert.ok(request.options)
    const stream = worker.query(request)

    if (request.options.persistSession !== false) {
      const close = stream.close.bind(stream)

      stream.close = () => {
        if (!committed) {
          committed = true
          git({
            cwd: folder,
            args: [
              'commit',
              '-q',
              '--allow-empty',
              '-m',
              'Final background work',
            ],
          })
        }

        close()
      }
    }

    return stream
  }

  const host = createHost({
    hydraId,
    query,
    changed: () => {},
  })
  const stopOffering = offerHost({
    hydraId,
    ask: async ({ body }) => {
      assert.equal(
        body.action,
        'release',
      )
      assert.equal(
        body.permanent,
        true,
      )
      assert.ok(typeof body.task === 'string')

      return host.release({
        task: body.task,
        permanent: true,
      })
    },
  })

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
      await assert.rejects(
        release,
        { code: 'CONFLICT' },
      )
      assert.equal(
        loadHydra({ hydraId }).state.cards[task]?.copy?.state,
        'active',
      )
    } else {
      const result = await release()
      assert.equal(
        result.copy?.state,
        'flagged',
      )
      assert.equal(
        result.check?.landed,
        false,
      )
    }

    assert.equal(
      worker.closed(),
      true,
    )
    assert.equal(
      committed,
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
    stopOffering()
    host.close()
  }
}

console.log('Copy release rechecked final background work before removal')
