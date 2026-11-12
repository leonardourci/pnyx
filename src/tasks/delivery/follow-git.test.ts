import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs, { type FSWatcher } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { emptyHydra, replay } from '#app/reducer.ts'
import { readStream } from '#test-harness/streams.ts'
import { settle } from '#test-harness/child-fixture.ts'
import { followGit, GIT_RETRY_MS } from './follow-git.ts'

// Long enough for a native watch to report a ref write it was going to report.
const QUIET_REF_MS = 300

test(
  'only a change to its own branch makes a working task pull request due, and failed watches back off',
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
    const changes: string[] = []
    const watching = followGit({
      changed: ({ task }) => {
        changes.push(task)
      },
    })
    const opened: FSWatcher[] = []
    const closed = new Set<FSWatcher>()
    const watch = fs.watch
    let refuseSetup = true
    let attempts = 0
    t.mock.method(
      fs,
      'watch',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.watch's signature.
      (...parameters: [
        fs.PathLike,
        fs.WatchOptionsWithStringEncoding,
        fs.WatchListener<string>?,
      ]) => {
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

        attempts++

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
    t.mock.timers.enable({
      apis: ['Date'],
      now: 0,
    })
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
    const branch = execFileSync(
      'git',
      [
        '-C',
        root,
        'symbolic-ref',
        '--short',
        'HEAD',
      ],
      { encoding: 'utf8' },
    ).trim()
    const refs = join(
      root,
      '.git',
      'refs',
    )
    const remote = join(
      refs,
      'remotes',
      'origin',
    )
    mkdirSync(
      remote,
      { recursive: true },
    )
    await watching.reconcile({ state })
    assert.equal(
      attempts,
      0,
      'a missing repository is not tried again on the next pump',
    )
    t.mock.timers.tick(GIT_RETRY_MS)
    await watching.reconcile({ state })
    await watching.reconcile({ state })
    assert.equal(
      attempts,
      1,
      'a failed watch setup is not tried again on the next pump',
    )
    t.mock.timers.tick(GIT_RETRY_MS)
    await watching.reconcile({ state })
    assert.equal(
      opened.length,
      1,
      'a missing repository and a failed watch setup are retried once their wait passed',
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
    t.mock.timers.tick(GIT_RETRY_MS)
    await watching.reconcile({ state })
    assert.equal(
      opened.length,
      2,
      'a failed installed watcher is retried',
    )
    writeFileSync(
      join(
        refs,
        'heads',
        'another-copy',
      ),
      'a'.repeat(40),
    )
    await wait(QUIET_REF_MS)
    assert.deepEqual(
      changes,
      [],
      'installing the watcher and another copy\'s commit report no change',
    )
    writeFileSync(
      join(
        remote,
        branch,
      ),
      'a'.repeat(40),
    )
    await settle({
      what: 'the ref change',
      check: () => changes.length,
    })
    assert.ok(changes.every(task => task === card.id))
    card.sessionActivity = 'finished'
    delete card.status
    await watching.reconcile({ state })
    await settle({
      what: 'finished task ref watcher to close',
      check: () => closed.has(opened[1]!),
    })
  },
)
