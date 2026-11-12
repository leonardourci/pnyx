import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs, { type FSWatcher } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyHydra, replay } from '#app/reducer.ts'
import { readStream } from '#test-harness/streams.ts'
import { settle } from '#test-harness/child-fixture.ts'
import { followGit } from './follow-git.ts'

test(
  'a local Git ref change makes a working task pull request due immediately',
  async t => {
    const root = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-follow-refs-',
    )))
    const state = replay({
      state: emptyHydra(),
      events: readStream({ name: 'lifecycle' }),
    })
    const card = state.cards.c1!
    card.hidden = false
    card.sessionActivity = 'working'
    card.copy = {
      path: root,
      project: root,
      via: 'command',
      state: 'active',
    }
    card.links = [
      {
        kind: 'github_pr',
        url: 'https://github.com/synthetic/repo/pull/1',
      },
    ]
    let changed: string | undefined
    const watching = followGit({
      changed: ({ task }) => {
        changed = task
      },
    })
    const opened: FSWatcher[] = []
    const closed = new Set<FSWatcher>()
    const watch = fs.watch
    let refuseSetup = true
    t.mock.method(
      fs,
      'watch',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.watch's signature.
      (...parameters: Parameters<typeof fs.watch>) => {
        const options = parameters[1]
        const recursive = typeof options === 'object' && options?.recursive

        if (!recursive) {
          return watch(...parameters)
        }

        if (parameters[0] !== join(
          root,
          '.git',
          'refs',
        )) {
          return watch(...parameters)
        }

        if (refuseSetup) {
          refuseSetup = false
          throw new Error('Synthetic native watch refusal')
        }

        const watcher = watch(...parameters)
        opened.push(watcher)
        watcher.once(
          'close',
          () => closed.add(watcher),
        )

        return watcher
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      watching.close()
      t.mock.restoreAll()
      syncBuiltinESMExports()
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    await watching.reconcile({ state })
    execFileSync(
      'git',
      [
        'init',
        '-q',
        root,
      ],
    )
    await watching.reconcile({ state })
    assert.equal(
      opened.length,
      0,
    )
    await watching.reconcile({ state })
    assert.equal(
      opened.length,
      1,
      'a missing repository and a failed watch setup are retried',
    )
    opened[0]!.emit(
      'error',
      new Error('Synthetic installed watcher failure'),
    )
    await settle({
      what: 'failed ref watcher to close',
      check: () => closed.has(opened[0]!),
    })
    await watching.reconcile({ state })
    assert.equal(
      opened.length,
      2,
      'a failed installed watcher is retried',
    )
    const remote = join(
      root,
      '.git',
      'refs',
      'remotes',
      'origin',
    )
    mkdirSync(
      remote,
      { recursive: true },
    )
    writeFileSync(
      join(
        remote,
        'worker',
      ),
      'a'.repeat(40),
    )
    await settle({
      what: 'the ref change',
      check: () => changed,
    })
    assert.equal(
      changed,
      card.id,
    )
    card.sessionActivity = 'finished'
    delete card.status
    await watching.reconcile({ state })
    await settle({
      what: 'finished task ref watcher to close',
      check: () => closed.has(opened[1]!),
    })
  },
)
