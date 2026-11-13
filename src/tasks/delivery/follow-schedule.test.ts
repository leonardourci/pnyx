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
import { settle } from '#test-harness/child-fixture.ts'
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
      result: 'found',
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
    link.mergeAttempt = {
      outcome: 'queued',
      head: 'fixture',
      requestedAt: '2026-11-12T00:00:00Z',
    }
    assert.equal(
      schedule.due({
        card,
        link,
        now: 60_000,
      }),
      true,
    )
    link.mergeAttempt.outcome = 'unknown'
    assert.equal(
      schedule.due({
        card,
        link,
        now: 60_000,
      }),
      true,
    )
    link.mergeAttempt.outcome = 'merged'
    assert.equal(
      schedule.due({
        card,
        link,
        now: 60_000,
      }),
      false,
    )
    delete link.mergeAttempt
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
      result: 'missing',
      now: 60_000,
    })
    schedule.read({
      card,
      link,
      result: 'missing',
      now: 120_000,
    })
    schedule.read({
      card,
      link,
      result: 'missing',
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
    schedule.touch({
      task: card.id,
      restart: true,
    })
    assert.equal(
      schedule.due({
        card,
        link,
        now: 3_600_000,
      }),
      true,
    )
    const detached = schedule.generation({ task: card.id })
    schedule.prune({ links: [] })
    schedule.touch({
      task: card.id,
      restart: true,
    })
    const reattached = schedule.generation({ task: card.id })
    assert.notEqual(
      reattached,
      detached,
      'reattached tasks receive a new generation',
    )
    schedule.read({
      card,
      link,
      result: 'found',
      started: detached,
      now: 3_600_000,
    })
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
  'failed reads keep a link on its schedule and only unresolved links are suspended, once',
  () => {
    const card = replay({
      state: emptyHydra(),
      events: readStream({ name: 'lifecycle' }),
    }).cards.c1!
    card.sessionActivity = 'working'
    const link: Link = {
      kind: 'github_pr',
      url: 'https://github.com/synthetic/repo/pull/1',
    }
    const schedule = followSchedule({ interval: 60_000 })

    for (const now of [
      0,
      60_000,
      120_000,
      180_000,
    ]) {
      assert.equal(
        schedule.read({
          card,
          link,
          result: 'failed',
          now,
        }),
        false,
      )
    }

    assert.equal(
      schedule.due({
        card,
        link,
        now: 240_000,
      }),
      true,
      'a link whose reads failed is read again after one interval',
    )
    const suspensions = [
      240_000,
      300_000,
      360_000,
      420_000,
    ].map(now => schedule.read({
      card,
      link,
      result: 'missing',
      now,
    }))
    assert.deepEqual(
      suspensions,
      [
        false,
        false,
        true,
        false,
      ],
    )
  },
)

test(
  'an event touch keeps the read in flight and only a restart discards it',
  () => {
    const card = replay({
      state: emptyHydra(),
      events: readStream({ name: 'lifecycle' }),
    }).cards.c1!
    card.sessionActivity = 'working'
    const link: Link = {
      kind: 'github_pr',
      url: 'https://github.com/synthetic/repo/pull/1',
    }
    const schedule = followSchedule({ interval: 60_000 })
    const inFlight = schedule.generation({ task: card.id })
    schedule.touch({ task: card.id })
    schedule.read({
      card,
      link,
      result: 'found',
      started: inFlight,
      now: 0,
    })
    assert.equal(
      schedule.due({
        card,
        link,
        now: 1_000,
      }),
      false,
      'the read that was in flight when an event touched the task still counts',
    )
    const restarted = schedule.generation({ task: card.id })
    schedule.touch({
      task: card.id,
      restart: true,
    })
    schedule.read({
      card,
      link,
      result: 'found',
      started: restarted,
      now: 1_000,
    })
    assert.equal(
      schedule.due({
        card,
        link,
        now: 1_000,
      }),
      true,
      'a restart discards the read in flight',
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
    let schedule = followSchedule({ interval: 60_000 })
    let reads = 0
    let comments = 0
    let pause: Promise<void> | undefined
    let release = () => {}
    let failure = false
    let reportedState: 'open' | 'closed' | 'merged' = 'open'
    let outcomePause: Promise<void> | undefined
    let outcomeRelease = () => {}
    let outcomeStarted = false
    let outcomeReads = 0
    let outcomeFailure = false

    const readStatus = async () => {
      reads++
      const observed = comments
      const observedState = reportedState
      const failed = failure
      await pause

      if (failed) {
        throw new Error('Synthetic GitHub refusal')
      }

      return {
        state: observedState,
        draft: false,
        comments: observed,
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
      readOutcome: async () => {
        outcomeStarted = true
        outcomeReads++
        await outcomePause

        if (outcomeFailure) {
          throw new Error('Synthetic merge evidence refusal')
        }

        return {
          outcome: 'unknown' as const,
          detail: 'Synthetic unreadable merge evidence',
        }
      },
      tell: async () => {},
    })
    t.mock.timers.enable({
      apis: ['Date'],
      now: Date.now(),
    })
    pause = new Promise<void>(resolve => {
      release = resolve
    })
    const initial = follow()
    assert.equal(
      reads,
      1,
    )
    schedule.touch({
      task: card.id,
      restart: true,
    })
    release()
    await initial
    pause = undefined
    await follow()
    t.mock.timers.tick(60_000)
    await follow()
    assert.equal(
      reads,
      2,
    )
    t.mock.timers.tick(840_000)
    await follow()
    assert.equal(
      reads,
      3,
    )
    comments = 1
    schedule.touch({
      task: card.id,
      restart: true,
    })
    await follow()
    assert.equal(
      reads,
      4,
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[card.id]?.links[0]?.comments,
      1,
    )
    schedule.touch({
      task: card.id,
      restart: true,
    })
    failure = true
    pause = new Promise<void>(resolve => {
      release = resolve
    })
    const refused = follow()
    assert.equal(
      reads,
      5,
    )
    schedule.touch({
      task: card.id,
      restart: true,
    })
    failure = false
    comments = 2
    release()
    await refused
    pause = undefined
    await follow()
    assert.equal(
      reads,
      6,
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[card.id]?.links[0]?.comments,
      2,
    )
    reportedState = 'closed'
    comments = 99
    schedule.touch({
      task: card.id,
      restart: true,
    })
    pause = new Promise<void>(resolve => {
      release = resolve
    })
    const staleStatus = follow()
    schedule.touch({
      task: card.id,
      restart: true,
    })
    release()
    await staleStatus
    pause = undefined
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[card.id]?.links[0]?.state,
      'open',
      'a refresh discards the stale closed status',
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[card.id]?.links[0]?.comments,
      2,
    )

    schedule = followSchedule({ interval: 60_000 })
    reportedState = 'closed'
    schedule.touch({
      task: card.id,
      restart: true,
    })
    pause = new Promise<void>(resolve => {
      release = resolve
    })
    const detachedRead = follow()
    schedule.prune({ links: [] })
    schedule.generation({ task: card.id })
    release()
    await detachedRead
    pause = undefined
    await settle({
      what: 'reattached link keeps its current persisted state',
      check: () =>
        loadHydra({ hydraId: 'default' }).state.cards[card.id]?.links[0]?.state === 'open',
    })

    reportedState = 'merged'
    schedule.touch({
      task: card.id,
      restart: true,
    })
    pause = new Promise<void>(resolve => {
      release = resolve
    })
    const staleMergedStatus = follow()
    schedule.touch({
      task: card.id,
      restart: true,
    })
    release()
    await staleMergedStatus
    pause = undefined
    assert.equal(
      outcomeReads,
      0,
      'discarded merged status starts no merge evidence process',
    )

    reportedState = 'merged'
    comments = 3
    schedule.touch({
      task: card.id,
      restart: true,
    })
    outcomePause = new Promise<void>(resolve => {
      outcomeRelease = resolve
    })
    const staleOutcome = follow()
    await settle({
      what: 'merge evidence request',
      check: () => outcomeStarted,
    })
    schedule.touch({
      task: card.id,
      restart: true,
    })
    outcomeRelease()
    await staleOutcome
    outcomePause = undefined
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[card.id]?.links[0]?.comments,
      2,
      'a refresh during merge evidence also discards the old status',
    )

    schedule.touch({
      task: card.id,
      restart: true,
    })
    outcomeFailure = true
    await assert.rejects(
      follow(),
      /Synthetic merge evidence refusal/,
    )
    outcomeFailure = false
    const beforeRetry = reads
    await follow()
    assert.equal(
      reads,
      beforeRetry + 1,
      'failed merge evidence leaves the existing deadline due',
    )
    await follow()
    assert.equal(
      reads,
      beforeRetry + 2,
      'unconfirmed merged status remains due until its proof is available',
    )
  },
)
