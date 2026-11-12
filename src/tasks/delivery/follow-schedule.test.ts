import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commands } from '#app/cli.ts'
import { loadHydra } from '#app/store.ts'
import { findCard } from '#tasks/push-rules.ts'
import { followPullRequests } from './follow.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, replay } from '#app/reducer.ts'
import { readStream } from '#test-harness/streams.ts'
import { followSchedule } from './follow-schedule.ts'
import type { Link } from './model.ts'

test(
  'idle PRs back off, active work stays fresh, and unresolved links stop until the task is touched',
  () => {
    const card = replay({
      state: emptyHydra(),
      events: readStream({ name: 'lifecycle' }),
    }).cards.c1!
    card.sessionActivity = 'finished'
    card.activity = 'finished'
    delete card.status
    const link: Link = {
      kind: 'github_pr',
      url: 'https://github.com/synthetic/repo/pull/1',
      checks: '1 passed, 1 total',
    }
    const schedule = followSchedule({ interval: 60_000 })
    assert.equal(
      schedule.due({
        card,
        link,
        now: 0,
      }),
      true,
    )
    schedule.read({
      card,
      link,
      found: true,
      now: 0,
    })
    assert.equal(
      schedule.due({
        card,
        link,
        now: 60_000,
      }),
      false,
    )
    assert.equal(
      schedule.due({
        card,
        link,
        now: 899_999,
      }),
      false,
    )
    assert.equal(
      schedule.due({
        card,
        link,
        now: 900_000,
      }),
      true,
    )
    card.sessionActivity = 'working'
    assert.equal(
      schedule.due({
        card,
        link,
        now: 60_000,
      }),
      true,
    )
    card.sessionActivity = 'finished'
    link.checks = '1 pending, 1 total'
    assert.equal(
      schedule.due({
        card,
        link,
        now: 60_000,
      }),
      true,
    )
    schedule.read({
      card,
      link,
      found: false,
      now: 60_000,
    })
    schedule.read({
      card,
      link,
      found: false,
      now: 120_000,
    })
    schedule.read({
      card,
      link,
      found: false,
      now: 180_000,
    })
    assert.equal(
      schedule.due({
        card,
        link,
        now: 3_600_000,
      }),
      false,
    )
    schedule.touch({ task: card.id })
    assert.equal(
      schedule.due({
        card,
        link,
        now: 3_600_000,
      }),
      true,
    )
  },
)

test(
  'the follower skips unchanged idle reads and a task refresh observes new comments immediately',
  async t => {
    const previous = process.env.PNYX_HOME
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-follow-policy-',
    ))
    process.env.PNYX_HOME = root
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    await commands.task([
      'create',
      '--key',
      'ship',
      '--title',
      'Ship',
    ])
    await commands.link([
      'ship',
      '--url',
      'https://github.com/synthetic/repo/pull/1',
    ])
    const card = findCard({
      state: loadHydra({ hydraId: 'default' }).state,
      ref: 'ship',
    })
    const schedule = followSchedule({ interval: 60_000 })
    let reads = 0
    let comments = 0

    const readStatus = async () => {
      reads++

      return {
        state: 'open' as const,
        draft: false,
        comments,
        checks: {
          passed: 1,
          failed: 0,
          pending: 0,
          skipped: 0,
          total: 1,
          summary: '1 passed, 1 total',
        },
      }
    }

    const follow = () => followPullRequests({
      hydraId: 'default',
      schedule,
      readStatus,
      tell: async () => {},
    })
    t.mock.timers.enable({
      apis: ['Date'],
      now: Date.now(),
    })
    await follow()
    t.mock.timers.tick(60_000)
    await follow()
    assert.equal(
      reads,
      1,
    )
    t.mock.timers.tick(840_000)
    await follow()
    assert.equal(
      reads,
      2,
    )
    comments = 1
    schedule.touch({ task: card.id })
    await follow()
    assert.equal(
      reads,
      3,
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[card.id]?.links[0]?.comments,
      1,
    )
  },
)
