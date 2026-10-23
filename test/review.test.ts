import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { decidePush } from '../src/core/decide.ts'
import { commands } from '../src/cli/commands.ts'
import { HYDRA_CARD, hydraEvent } from '../src/core/hydra.ts'
import type { Card, HydraState } from '../src/core/model.ts'
import { emptyHydra } from '../src/core/reducer.ts'
import { wakeReasons } from '../src/core/wake-reasons.ts'
import { boardReview, MINUTE_MS, QUESTION_REMINDER_MS } from '../src/review/board.ts'
import { REVIEW_MS, startReviewTimer } from '../src/review/timer.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const OLD = '2026-10-24T06:00:00Z'
const PR = 'https://github.com/example/project/pull/7'

const task = ({
  id = 'task',
  ...fields
}: Partial<Card> = {}): Card => ({
  id,
  key: id,
  title: id,
  workspace: 'app',
  tags: [],
  attention: [],
  links: [],
  sourceRefs: [],
  column: 'in_progress',
  revision: 1,
  createdSeq: 1,
  updatedSeq: 1,
  updatedAt: OLD,
  ...fields,
})

const reviewState = ({ cards }: { cards: Card[] }): HydraState => ({
  ...emptyHydra(),
  seq: 20,
  cards: Object.fromEntries(cards.map(card => [
    card.id,
    card,
  ])),
})

test(
  'the review names the live facts, ready order, and each actionable flag',
  () => {
    const approved = task({
      id: 'approved',
      landing: {
        landing: 'pr',
        merge: 'hydra',
      },
      links: [
        {
          kind: 'github_pr',
          url: PR,
          state: 'open',
          checks: '2 passed, 2 total',
          checkedAt: OLD,
        },
      ],
    })
    const blocked = task({
      id: 'blocked',
      status: {
        id: 'status',
        at: OLD,
        actor: 'worker',
        state: 'blocked',
        note: 'Only unrelated full suite failures remain',
      },
      links: [
        {
          kind: 'github_pr',
          url: PR,
          state: 'open',
          checks: '1 passed, 1 failed, 2 total',
        },
      ],
    })
    const question = task({
      id: 'question',
      asks: [
        {
          id: 'ask',
          at: OLD,
          actor: 'hydra',
          audience: 'owner',
          question: 'Merge on the focused checks?',
        },
      ],
    })
    const state = reviewState({
      cards: [
        approved,
        blocked,
        question,
        task({
          id: 'second',
          column: 'queued',
          rank: 2,
        }),
        task({
          id: 'first',
          column: 'queued',
          rank: 1,
        }),
        task({
          id: 'held',
          column: 'queued',
          status: {
            id: 'hold',
            at: OLD,
            actor: 'hydra',
            state: 'paused',
            hold: true,
            note: 'Discuss first',
          },
        }),
      ],
    })
    state.hydraMemory = {
      'check-cursor': {
        text: '3',
        at: OLD,
      },
    }
    const frozen = structuredClone(state)
    const review = boardReview({
      state,
      now: NOW,
    })
    assert.equal(
      review.live,
      true,
    )
    assert.deepEqual(
      new Set(review.flags.map(flag => flag.kind)),
      new Set([
        'approved merge is green',
        'external blocker',
        'question reminder',
        'no live worker',
        'unwatched PR',
        'memory behind',
      ]),
    )
    assert.match(
      review.block,
      /column: In progress; declaration:/,
    )
    assert.match(
      review.block,
      /quiet 360 min old/,
    )
    assert.match(
      review.block,
      /checks: 2 passed, 2 total \(360 min old\)/,
    )
    assert.match(
      review.block,
      /Question ask to owner: Merge on the focused checks\? \(360 min old\)/,
    )
    assert.ok(review.block.includes(PR))
    const ready = review.block.split('Ready in Backlog')[1]!.split('Review flags')[0]!
    assert.ok(ready.indexOf('[@first]') < ready.indexOf('[@second]'))
    assert.ok(!ready.includes('held'))
    assert.deepEqual(
      state,
      frozen,
    )
  },
)

test(
  'only live work, open PRs, open decisions or ready Backlog make a review due',
  () => {
    const idle = reviewState({ cards: [task({ column: 'done' })] })
    assert.equal(
      boardReview({
        state: idle,
        now: NOW,
      }).live,
      false,
    )
    const orphan = boardReview({
      state: reviewState({ cards: [task()] }),
      now: NOW,
    })
    assert.equal(
      orphan.live,
      false,
    )
    assert.ok(orphan.flags.some(flag => flag.kind === 'no live worker'))
    const cases: Card[] = [
      task({
        agent: {
          provider: 'claude',
          sessionId: 'worker',
        },
      }),
      task({
        links: [
          {
            kind: 'github_pr',
            url: PR,
            state: 'open',
          },
        ],
      }),
      task({
        asks: [
          {
            id: 'ask',
            at: OLD,
            actor: 'worker',
            audience: 'hydra',
            question: 'Which parser?',
          },
        ],
      }),
      task({ column: 'queued' }),
    ]

    for (const card of cases) {
      assert.equal(
        boardReview({
          state: reviewState({ cards: [card] }),
          now: NOW,
        }).live,
        true,
      )
    }
  },
)

test(
  'question reminders respect age and the last review reminder across restart',
  () => {
    const card = task({
      asks: [
        {
          id: 'ask',
          at: OLD,
          actor: 'hydra',
          audience: 'owner',
          question: 'Go?',
        },
      ],
    })
    const state = reviewState({ cards: [card] })
    state.hydraReview = {
      at: new Date(NOW).toISOString(),
      seq: 19,
      block: '',
      reminders: { 'task:ask': new Date(NOW - MINUTE_MS).toISOString() },
    }
    assert.deepEqual(
      boardReview({
        state,
        now: NOW,
      }).reminders,
      [],
    )
    assert.deepEqual(
      boardReview({
        state,
        now: NOW + QUESTION_REMINDER_MS,
      }).reminders,
      ['task:ask'],
    )
    card.asks![0]!.at = new Date(NOW).toISOString()
    assert.deepEqual(
      boardReview({
        state,
        now: NOW,
      }).reminders,
      [],
    )
  },
)

test(
  'red, pending, draft and unapproved PRs never get an approved-green flag',
  () => {
    for (const changes of [
      { checks: '1 passed, 1 failed, 2 total' },
      { checks: '1 passed, 2 total' },
      {
        checks: '2 passed, 2 total',
        draft: true,
      },
      { checks: '0 total' },
    ]) {
      const card = task({
        landing: {
          landing: 'pr',
          merge: 'hydra',
        },
        links: [
          {
            kind: 'github_pr',
            url: PR,
            state: 'open',
            ...changes,
          },
        ],
      })
      const review = boardReview({
        state: reviewState({ cards: [card] }),
        now: NOW,
      })
      assert.ok(!review.flags.some(flag => flag.kind === 'approved merge is green'))
    }
  },
)

let root = ''
let previous: string | undefined
let timer: ReturnType<typeof startReviewTimer> | undefined
const state = () => loadHydra({ hydraId: 'lab' }).state
const reviews = () => readEvents({ hydraId: 'lab' }).filter(event => event.type === 'hydra.review')

test(
  'external blocker flags require a reported infrastructure issue or unrelated full-suite failure',
  () => {
    for (const note of [
      'Only a cancelled run remains',
      'The base is out of date',
      'Unrelated full-suite timing failures',
    ]) {
      const card = task({
        status: {
          id: 'blocked',
          actor: 'worker',
          at: OLD,
          state: 'blocked',
          note,
        },
        links: [
          {
            kind: 'github_pr',
            url: PR,
            state: 'open',
          },
        ],
      })
      assert.ok(boardReview({
        state: reviewState({ cards: [card] }),
        now: NOW,
      }).flags.some(flag => flag.kind === 'external blocker'))
      card.status!.note = 'My change fails the full suite'
      assert.ok(!boardReview({
        state: reviewState({ cards: [card] }),
        now: NOW,
      }).flags.some(flag => flag.kind === 'external blocker'))
    }
  },
)

test(
  'review quiet time includes a hosted worker transcript growing since its last observation',
  () => {
    commands.task([
      'create',
      '--title',
      'Streaming worker',
      '--key',
      'stream',
      '--hydra',
      'lab',
    ])
    const transcript = join(
      root,
      'synthetic-worker.jsonl',
    )
    writeFileSync(
      transcript,
      '{}\n',
    )
    let clock = NOW
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const decision = decidePush({
          state: writer.state,
          key: 'stream',
          input: {
            activity: 'working',
            agent: {
              provider: 'claude',
              host: 'pnyx',
              sessionId: 'synthetic',
              transcriptPath: transcript,
            },
          },
          meta: {
            actor: 'test',
            at: OLD,
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    timer = startReviewTimer({
      hydraId: 'lab',
      now: () => clock,
      interval: () => () => {},
      wake: () => {},
    })
    clock += REVIEW_MS
    utimesSync(
      transcript,
      clock / 1000,
      clock / 1000,
    )
    timer.check()
    assert.match(
      reviews()[0]!.data.block,
      /worker: working, quiet 0 min old/,
    )
  },
)

test(
  'review reminders use the question Hydra escalated to the owner',
  () => {
    const state = reviewState({
      cards: [
        task({
          asks: [
            {
              id: 'ask',
              actor: 'worker',
              at: OLD,
              audience: 'owner',
              question: 'Can I skip these failures?',
              escalated: {
                id: 'escalation',
                actor: 'hydra',
                at: OLD,
                question: 'Merge on focused checks, or wait for the suite repair?',
              },
            },
          ],
        }),
      ],
    })
    const review = boardReview({
      state,
      now: NOW,
    })
    assert.match(
      review.block,
      /Question ask to owner: Merge on focused checks/,
    )
    assert.match(
      review.flags.find(flag => flag.kind === 'question reminder')!.detail,
      /Merge on focused checks/,
    )
    assert.ok(!review.block.includes('Can I skip'))
  },
)

test(
  'an offered question reminder is recorded and stays suppressed after a timer restart',
  () => {
    commands.task([
      'create',
      '--title',
      'Owner decision',
      '--key',
      'decision',
      '--hydra',
      'lab',
    ])
    const card = state().keys.decision!
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          meta: {
            actor: 'hydra',
            at: OLD,
          },
          cardId: card,
          change: {
            type: 'task.asked',
            data: {
              id: 'old-question',
              audience: 'owner',
              question: 'Go?',
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    let clock = NOW
    const start = () => startReviewTimer({
      hydraId: 'lab',
      now: () => clock,
      interval: () => () => {},
      wake: () => {},
    })
    timer = start()
    clock += REVIEW_MS
    timer.check()
    const key = `${card}:old-question`
    assert.deepEqual(
      reviews()[0]?.data.reminders,
      [key],
    )
    assert.match(
      reviews()[0]!.data.block,
      /question reminder: old-question/,
    )
    assert.equal(
      state().hydraReview?.reminders[key],
      new Date(clock).toISOString(),
    )
    timer.close()
    timer = start()
    clock += REVIEW_MS
    timer.check()
    assert.deepEqual(
      reviews()[1]?.data.reminders,
      [],
    )
    assert.ok(!reviews()[1]!.data.block.includes('question reminder:'))
    clock += QUESTION_REMINDER_MS
    timer.check()
    assert.deepEqual(
      reviews()[2]?.data.reminders,
      [key],
    )
  },
)

beforeEach(() => {
  previous = process.env.PNYX_HOME
  root = mkdtempSync(join(
    tmpdir(),
    'pnyx-review-',
  ))
  process.env.PNYX_HOME = root
  process.env.PNYX_SEMANTIC = 'off'
  commands.hydra([
    'create',
    'lab',
  ])
})

afterEach(() => {
  timer?.close()
  timer = undefined

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

test(
  'a controllable clock yields one durable review per interval and no restart duplicate',
  () => {
    let clock = NOW
    let wakes = 0
    const start = () => startReviewTimer({
      hydraId: 'lab',
      now: () => clock,
      interval: () => () => {},
      wake: () => wakes++,
    })
    timer = start()
    clock += REVIEW_MS
    timer.check()
    assert.equal(
      wakes,
      0,
    )
    commands.task([
      'create',
      '--title',
      'Ready work',
      '--hydra',
      'lab',
    ])
    timer.check()
    timer.check()
    assert.equal(
      wakes,
      1,
    )
    assert.equal(
      reviews().length,
      1,
    )
    assert.deepEqual(
      wakeReasons({
        state: state(),
        events: reviews(),
      }),
      ['- timed review'],
    )
    assert.equal(
      state().hydraReview?.at,
      new Date(clock).toISOString(),
    )
    timer.close()
    timer = start()
    clock += REVIEW_MS - 1
    timer.check()
    assert.equal(
      wakes,
      1,
    )
    clock++
    timer.check()
    assert.equal(
      wakes,
      2,
    )
    assert.equal(
      reviews().length,
      2,
    )
  },
)

test(
  'a running turn defers the review until it finishes, and settings disable and change cadence',
  () => {
    let clock = NOW
    let wakes = 0
    let queued = false
    commands.task([
      'create',
      '--title',
      'Ready work',
      '--hydra',
      'lab',
    ])
    const activity = ({ value }: { value: string }) => withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const decision = decidePush({
          state: writer.state,
          key: HYDRA_CARD,
          input: {
            activity: value,
          },
          meta: {
            actor: 'test',
            at: new Date(clock).toISOString(),
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    timer = startReviewTimer({
      hydraId: 'lab',
      now: () => clock,
      interval: () => () => {},
      wake: () => wakes++,
      busy: () => queued,
    })
    activity({ value: 'working' })
    clock += REVIEW_MS
    timer.check()
    assert.equal(
      wakes,
      0,
    )
    activity({ value: 'finished' })
    queued = true
    timer.check()
    assert.equal(
      wakes,
      0,
    )
    queued = false
    timer.check()
    assert.equal(
      wakes,
      1,
    )
    commands.hydra([
      'set',
      '--review-minutes',
      '0',
      '--hydra',
      'lab',
    ])
    clock += REVIEW_MS
    timer.check()
    assert.equal(
      wakes,
      1,
    )
    commands.hydra([
      'set',
      '--review-minutes',
      '5',
      '--hydra',
      'lab',
    ])
    timer.check()
    assert.equal(
      wakes,
      2,
    )
    clock += 5 * MINUTE_MS - 1
    timer.check()
    assert.equal(
      wakes,
      2,
    )
    clock++
    timer.check()
    assert.equal(
      wakes,
      3,
    )

    for (const value of [
      '-1',
      'NaN',
      'Infinity',
      '',
      '999999999999',
    ]) {
      assert.throws(
        () => commands.hydra([
          'set',
          '--review-minutes',
          value,
          '--hydra',
          'lab',
        ]),
        /review-minutes/,
      )
    }
  },
)
