import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-follow-refs-',
    ))
    execFileSync(
      'git',
      [
        'init',
        '-q',
        root,
      ],
    )
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
    t.after(() => {
      watching.close()
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    await watching.reconcile({ state })
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
  },
)
