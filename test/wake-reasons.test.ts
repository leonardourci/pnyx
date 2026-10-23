import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decidePush } from '../src/core/decide.ts'
import { declareTask, HYDRA_CARD } from '../src/core/hydra.ts'
import type { Card, HydraEvent, HydraState, Link, TaskStatus } from '../src/core/model.ts'
import { emptyHydra, reduce } from '../src/core/reducer.ts'
import { taskMention } from '../src/mentions/mentions.ts'
import { reasonLine, wakeReasons, wakesHydra } from '../src/core/wake-reasons.ts'

const PR = 'https://github.com/o/r/pull/7'

const card = ({
  id,
  ...fields
}: Partial<Card> & { id: string }): Card => ({
  id,
  key: id,
  title: `Task ${id}`,
  workspace: 'w',
  tags: [],
  attention: [],
  links: [],
  sourceRefs: [],
  column: 'queued',
  revision: 1,
  createdSeq: 1,
  updatedSeq: 1,
  updatedAt: '2026-10-23T10:00:00.000Z',
  ...fields,
})

// A hosted Hydra, so every change below is one Pnyx would wake it for.
const hydraState = ({
  cards,
  projects,
}: {
  cards: Card[]
  projects?: HydraState['projects']
}): HydraState => ({
  seq: 100,
  cards: Object.fromEntries([
    card({
      id: HYDRA_CARD,
      agent: {
        host: 'pnyx',
        provider: 'claude',
        sessionId: 'hydra',
      },
    }),
    ...cards,
  ].map(c => [
    c.id,
    c,
  ])),
  keys: {},
  eventIds: {},
  projects,
}) as unknown as HydraState

let seq = 0

const event = ({
  type,
  cardId = 'fix',
  actor = 'worker:fix',
  data,
}: {
  type: HydraEvent['type']
  cardId?: string
  actor?: string
  data: unknown
}): HydraEvent => ({
  id: `evt_${++seq}`,
  seq,
  at: '2026-10-23T10:05:00.000Z',
  actor,
  cardId,
  type,
  data,
}) as unknown as HydraEvent

const ref = ({ id }: { id: string }) => taskMention({
  id,
  title: `Task ${id}`,
})

const linked = ({
  before,
  after,
}: {
  before: Partial<Link> | null
  after: Partial<Link>
}) => event({
  type: 'card.linked',
  actor: 'pnyx',
  data: {
    url: PR,
    before: before && {
      kind: 'github_pr',
      url: PR,
      ...before,
    },
    after: {
      kind: 'github_pr',
      url: PR,
      ...after,
    },
  },
})

test(
  'a declaration names its state and note, and a worker message is a question or a report',
  () => {
    const state = hydraState({
      cards: [
        card({
          id: 'fix',
          asks: [
            {
              id: 'ask-3',
              at: '2026-10-23T10:04:00.000Z',
              actor: 'worker:fix',
              audience: 'hydra',
              question: 'Which parser owns dates?',
            },
          ],
        }),
      ],
    })

    assert.deepEqual(
      wakeReasons({
        state,
        events: [
          event({
            type: 'task.declared',
            data: {
              state: 'needs_you',
              note: 'Pick a parser',
            },
          }),
          event({
            type: 'hydra.message',
            data: {
              task: 'fix',
              action: 'send',
              ask: 'ask-3',
              text: 'Question ask-3: Which parser owns dates?\nAnswer: …',
            },
          }),
          event({
            type: 'hydra.message',
            data: {
              task: 'fix',
              action: 'send',
              text: 'Found the cause',
            },
          }),
        ],
      }),
      [
        `- ${ref({ id: 'fix' })} declared: needs_you, "Pick a parser"`,
        `- ${ref({ id: 'fix' })} asked: ask-3: "Which parser owns dates?"`,
        `- ${ref({ id: 'fix' })} report: from worker:fix, in its envelope below`,
      ],
    )
  },
)

test(
  'what wakes nobody gives no reason: progress, a working declaration, and Hydra\'s own writes',
  () => {
    const state = hydraState({ cards: [card({ id: 'fix' })] })

    assert.deepEqual(
      wakeReasons({
        state,
        events: [
          event({
            type: 'hydra.message',
            data: {
              task: 'fix',
              action: 'send',
              kind: 'progress',
              text: 'Halfway',
            },
          }),
          event({
            type: 'task.declared',
            data: {
              state: 'working',
              note: 'on it',
            },
          }),
          event({
            type: 'task.declared',
            actor: 'hydra',
            data: {
              state: 'needs_you',
              note: 'Hydra asked',
            },
          }),
        ],
      }),
      [],
    )
  },
)

test(
  'a finished turn is a reason only while the worker still declares working or has declared nothing',
  () => {
    const turn = ({
      status,
      attention = [],
      endedHere = true,
    }: {
      status?: TaskStatus
      attention?: Card['attention']
      endedHere?: boolean
    }) => {
      const ended = event({
        type: 'card.pushed',
        data: {
          key: 'fix',
          activity: 'finished',
          before: { activity: 'working' },
        },
      })

      return wakeReasons({
        state: hydraState({
          cards: [
            card({
              id: 'fix',
              tracking: 'declared',
              status: status && {
                id: 'd',
                at: '2026-10-23T10:01:00.000Z',
                actor: 'worker:fix',
                state: status,
                note: '',
              },
              attention,
              turnEndedSeq: endedHere ? ended.seq : ended.seq - 1,
            }),
          ],
        }),
        events: [ended],
      })
    }

    assert.deepEqual(
      turn({ status: 'working' }),
      [`- ${ref({ id: 'fix' })} turn ended: the worker finished its turn still declaring working`],
    )
    assert.deepEqual(
      turn({}),
      [`- ${ref({ id: 'fix' })} turn ended: the worker finished its turn without declaring anything`],
    )

    for (const status of [
      'needs_you',
      'blocked',
      'paused',
      'done',
    ] as const) {
      assert.deepEqual(
        turn({ status }),
        [],
        `a worker that declared ${status} said why it stopped`,
      )
    }

    assert.deepEqual(
      turn({
        status: 'working',
        attention: [
          {
            kind: 'question',
            key: 'q1',
            blocking: true,
          },
        ],
      }),
      [],
      'an open question is the worker\'s reason, not its finished turn',
    )
    assert.deepEqual(
      turn({
        status: 'working',
        endedHere: false,
      }),
      [],
      'a finished push that ended no working turn is not a turn end',
    )
  },
)

test(
  'a hook session\'s Stop ends its turn through the reducer, which wakes Hydra',
  () => {
    const meta = ({ actor }: { actor: string }) => ({
      at: '2026-10-23T10:00:00.000Z',
      actor,
    })

    const push = ({
      state,
      activity,
    }: {
      state: HydraState
      activity: string
    }) => {
      const decision = decidePush({
        state,
        key: 'fix',
        input: {
          title: 'Task fix',
          activity,
          source: {
            adapter: 'hooks',
            objectId: 's1',
          },
        },
        meta: meta({ actor: 'hook:s1' }),
      })
      assert.ok('event' in decision)

      return decision.event
    }

    let state = reduce({
      state: emptyHydra(),
      event: push({
        state: emptyHydra(),
        activity: 'working',
      }),
    })
    const declared = declareTask({
      state,
      ref: 'fix',
      status: 'working',
      note: 'on it',
      meta: meta({ actor: 'worker:fix' }),
    })
    assert.ok('event' in declared)
    state = reduce({
      state,
      event: declared.event,
    })
    const stop = push({
      state,
      activity: 'finished',
    })
    state = reduce({
      state,
      event: stop,
    })
    // Hydra's own card, as a Pnyx-run Hydra has it.
    state.cards[HYDRA_CARD] = hydraState({ cards: [] }).cards[HYDRA_CARD]!

    assert.ok(wakesHydra({
      state,
      event: stop,
    }))
    assert.match(
      wakeReasons({
        state,
        events: [stop],
      })[0]!,
      /\) turn ended: the worker finished its turn still declaring working$/,
    )
  },
)

test(
  'settled checks say green or red, an approved merge says so, and a merge names the pull request',
  () => {
    const fix = card({
      id: 'fix',
      sessionIds: ['s1'],
      project: 'pnyx',
      links: [
        {
          kind: 'github_pr',
          url: PR,
          state: 'open',
        },
      ],
    })
    const state = hydraState({ cards: [fix] })

    assert.deepEqual(
      wakeReasons({
        state,
        events: [
          linked({
            before: {
              state: 'open',
              checks: '1 passed, 2 total',
            },
            after: {
              state: 'open',
              checks: '2 passed, 2 total',
            },
          }),
          linked({
            before: {
              state: 'open',
              checks: '2 passed, 3 total',
            },
            after: {
              state: 'open',
              checks: '2 passed, 1 failed, 3 total',
            },
          }),
          linked({
            before: { state: 'open' },
            after: { state: 'merged' },
          }),
        ],
      }),
      [
        `- ${ref({ id: 'fix' })} checks: ${PR} green (2 passed, 2 total)`,
        `- ${ref({ id: 'fix' })} checks: ${PR} red (2 passed, 1 failed, 3 total)`,
        `- ${ref({ id: 'fix' })} merged: ${PR}`,
      ],
    )

    const approved = hydraState({
      cards: [fix],
      projects: [
        {
          path: '/p/pnyx',
          name: 'pnyx',
          detached: false,
          merge: 'hydra',
        },
      ],
    })

    assert.deepEqual(
      wakeReasons({
        state: approved,
        events: [
          linked({
            before: {
              state: 'open',
              checks: '1 passed, 1 failed, 2 total',
            },
            after: {
              state: 'open',
              checks: '2 passed, 2 total',
            },
          }),
        ],
      }),
      [`- ${ref({ id: 'fix' })} approved merge is green: ${PR} (2 passed, 2 total)`],
    )

    const settle = ({
      state,
      checks,
    }: {
      state: HydraState
      checks: string
    }) => wakeReasons({
      state,
      events: [
        linked({
          before: {
            state: 'open',
            checks: '1 passed, 2 total',
          },
          after: {
            state: 'open',
            checks,
          },
        }),
      ],
    })

    assert.deepEqual(
      settle({
        state: approved,
        checks: '1 passed, 1 failed, 2 total',
      }),
      [`- ${ref({ id: 'fix' })} checks: ${PR} red (1 passed, 1 failed, 2 total)`],
      'red checks are never an approved merge',
    )

    const working = hydraState({
      cards: [
        {
          ...fix,
          status: {
            id: 'w',
            at: '2026-10-23T10:00:00.000Z',
            actor: 'worker:fix',
            state: 'working',
            note: 'addressing review comments',
          },
        },
      ],
      projects: approved.projects,
    })

    assert.deepEqual(
      settle({
        state: working,
        checks: '2 passed, 2 total',
      }),
      [`- ${ref({ id: 'fix' })} checks: ${PR} green (2 passed, 2 total)`],
      'a worker still working on it holds the merge',
    )
  },
)

test(
  'failed checks and new comments are Hydra\'s only when no worker watches the pull request',
  () => {
    const unwatched = hydraState({
      cards: [
        card({
          id: 'fix',
          links: [
            {
              kind: 'github_pr',
              url: PR,
              state: 'open',
            },
          ],
        }),
      ],
    })

    assert.deepEqual(
      wakeReasons({
        state: unwatched,
        events: [
          linked({
            before: {
              state: 'open',
              checks: '0 passed, 3 total',
            },
            after: {
              state: 'open',
              checks: '0 passed, 1 failed, 3 total',
            },
          }),
          linked({
            before: {
              state: 'open',
              comments: 1,
            },
            after: {
              state: 'open',
              comments: 3,
            },
          }),
        ],
      }),
      [
        `- ${ref({ id: 'fix' })} checks: ${PR} red (0 passed, 1 failed, 3 total), and no worker watches it`,
        `- ${ref({ id: 'fix' })} comments: 2 new on ${PR}, and no worker watches it`,
      ],
    )
  },
)

test(
  'a worker\'s new blocking question is asked, and a session that ends with its pull request unwatched says so',
  () => {
    const state = hydraState({
      cards: [
        card({
          id: 'fix',
          tracking: 'declared',
          stoppedAt: '2026-10-23T10:05:00.000Z',
          sessionIds: ['s1'],
          links: [
            {
              kind: 'github_pr',
              url: PR,
              state: 'open',
            },
          ],
        }),
      ],
    })

    assert.deepEqual(
      wakeReasons({
        state,
        events: [
          event({
            type: 'card.pushed',
            actor: 'hook:s1',
            data: {
              key: 'fix',
              attention: [
                {
                  kind: 'question',
                  key: 'q1',
                  blocking: true,
                  questions: [
                    {
                      question: 'Which DB?',
                      options: [],
                    },
                  ],
                },
              ],
              before: { attention: [] },
            },
          }),
          event({
            type: 'card.pushed',
            actor: 'hook:s1',
            data: {
              key: 'fix',
              activity: 'ended',
              before: { activity: 'finished' },
            },
          }),
        ],
      }),
      [
        `- ${ref({ id: 'fix' })} asked: q1: "Which DB?"`,
        `- ${ref({ id: 'fix' })} turn ended: the worker's session ended, and no worker watches ${PR}`,
      ],
    )
  },
)

test(
  'a permission, a reminder, the queue and a kind change each name their fact',
  () => {
    const state = hydraState({ cards: [card({ id: 'fix' })] })

    assert.deepEqual(
      wakeReasons({
        state,
        events: [
          event({
            type: 'task.permission',
            actor: 'hook:s1',
            data: {
              tool: 'Bash',
              status: 'pending',
            },
          }),
          event({
            type: 'task.reminder-due',
            actor: 'pnyx',
            data: {
              reminder: 'Check the deploy',
            },
          }),
          event({
            type: 'task.queue',
            actor: 'pnyx',
            data: {
              before: {
                session: 's1',
                rank: 1,
              },
              after: null,
            },
          }),
          event({
            type: 'task.queue',
            actor: 'owner',
            data: {
              before: null,
              after: {
                session: 's2',
                rank: 1,
              },
            },
          }),
          event({
            type: 'task.kind',
            actor: 'owner',
            data: {
              before: 'investigation',
              after: 'build',
            },
          }),
        ],
      }),
      [
        `- ${ref({ id: 'fix' })} permission: Bash waits for an answer`,
        `- ${ref({ id: 'fix' })} reminder due: Check the deploy`,
        `- ${ref({ id: 'fix' })} queue released`,
        `- ${ref({ id: 'fix' })} queued: behind s2`,
        `- ${ref({ id: 'fix' })} kind: investigation to build`,
      ],
    )
  },
)

test(
  'a done task frees a slot, listed with the ready Backlog cards in order; held, started or asking cards are not ready',
  () => {
    const state = hydraState({
      cards: [
        card({
          id: 'fix',
          column: 'done',
          links: [
            {
              kind: 'github_pr',
              url: PR,
              state: 'merged',
            },
          ],
        }),
        card({
          id: 'second',
          rank: 2,
        }),
        card({
          id: 'first',
          rank: 1,
        }),
        card({
          id: 'held',
          status: {
            id: 'h',
            at: '2026-10-23T09:00:00.000Z',
            actor: 'owner',
            state: 'paused',
            note: 'talk first',
            hold: true,
          },
        }),
        card({
          id: 'started',
          sessionIds: ['s3'],
        }),
        card({
          id: 'asking',
          asks: [
            {
              id: 'ask-9',
              at: '2026-10-23T09:00:00.000Z',
              actor: 'hydra',
              audience: 'owner',
              question: 'Which one?',
            },
          ],
        }),
      ],
    })
    const free = `- slot free: ready in Backlog, in order: ${ref({ id: 'first' })}, ${ref({ id: 'second' })}`

    assert.deepEqual(
      wakeReasons({
        state,
        events: [
          linked({
            before: { state: 'open' },
            after: { state: 'merged' },
          }),
          event({
            type: 'task.declared',
            actor: 'pnyx',
            data: {
              state: 'done',
              note: `Pull request ${PR} merged`,
            },
          }),
        ],
      }),
      [
        `- ${ref({ id: 'fix' })} merged: ${PR}`,
        `- ${ref({ id: 'fix' })} declared: done, "Pull request ${PR} merged"`,
        free,
      ],
      'only done frees the slot: a task with another open pull request keeps it',
    )
    assert.deepEqual(
      wakeReasons({
        state,
        events: [
          event({
            type: 'task.session',
            actor: 'owner',
            data: {
              session: 's1',
              before: 's1',
              after: null,
            },
          }),
        ],
      }),
      [],
      'a detach is often a replacement, so it frees nothing',
    )
  },
)

test(
  'a reason line without a task names only its fact',
  () => {
    assert.equal(
      reasonLine({
        state: hydraState({ cards: [] }),
        kind: 'not confirmed',
        detail: 'the message "Rebase" never showed up',
      }),
      '- not confirmed: the message "Rebase" never showed up',
    )
  },
)
