import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '#app/cli.ts'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { emptyHydra } from '#app/reducer.ts'
import { boardReview } from './review.ts'
import { startReviewTimer } from './review-timer.ts'

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

test(
  'the review flags a left-off once every task it links is finished, never for an unknown task, or once it is 7 days old',
  () => {
    const ALL_DONE = 'every task linked in Hydra memory `left-off` is done; rewrite or forget it'
    const TOO_OLD = 'Hydra memory `left-off` is over 7 days old; rewrite or forget it'
    const CHIPS = '[@Oracle redesign](pnyx-task:oracle) waits for [@Settings](pnyx-task:settings).'
    const leftOffFlag = ({
      cards,
      text = CHIPS,
      at = OLD,
    }: {
      cards: Card[]
      text?: string
      at?: string
    }) => boardReview({
      state: {
        ...reviewState({ cards }),
        hydraMemory: {
          'left-off': {
            text,
            at,
          },
        },
      },
      now: NOW,
    }).flags.find(flag => flag.kind === 'stale left-off')?.detail
    const done = {
      id: 'done',
      at: OLD,
      actor: 'worker',
      state: 'done' as const,
      note: 'Merged.',
    }
    const settingsDone = task({
      id: 'settings',
      status: done,
    })

    assert.equal(
      leftOffFlag({
        cards: [
          task({ id: 'oracle' }),
          settingsDone,
        ],
      }),
      undefined,
    )
    assert.equal(
      leftOffFlag({
        cards: [
          task({
            id: 'oracle',
            status: done,
          }),
          settingsDone,
        ],
      }),
      ALL_DONE,
    )
    assert.equal(
      leftOffFlag({
        cards: [
          task({
            id: 'oracle',
            column: 'done',
          }),
          settingsDone,
        ],
      }),
      ALL_DONE,
    )
    assert.equal(
      leftOffFlag({
        cards: [
          task({
            id: 'oracle',
            hidden: true,
          }),
          settingsDone,
        ],
      }),
      ALL_DONE,
    )
    assert.equal(
      leftOffFlag({ cards: [settingsDone] }),
      undefined,
    )
    assert.equal(
      leftOffFlag({
        cards: [],
        text: 'Waiting on the owner about icons.',
      }),
      undefined,
    )
    assert.equal(
      leftOffFlag({
        cards: [task({ id: 'oracle' })],
        at: '2026-10-17T12:00:01Z',
      }),
      undefined,
    )
    assert.equal(
      leftOffFlag({
        cards: [task({ id: 'oracle' })],
        at: '2026-10-17T12:00:00Z',
      }),
      TOO_OLD,
    )
  },
)

let root = ''
let previous: string | undefined
let timer: ReturnType<typeof startReviewTimer> | undefined

beforeEach(() => {
  previous = process.env.PNYX_HOME
  root = mkdtempSync(join(
    tmpdir(),
    'pnyx-review-',
  ))
  process.env.PNYX_HOME = root
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
