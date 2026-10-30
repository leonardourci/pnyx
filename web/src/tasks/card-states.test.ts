import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra } from '#app/reducer.ts'
import { cardState, genericPrompts } from './view.ts'
import { ownerQuestions } from '#tasks/questions.ts'
import { cardFacts, placeCard } from '#tasks/columns.ts'
import { DEFAULT_COLUMNS } from '#tasks/column-defaults.ts'
import { INTERRUPTED } from '#workers/session-attachments.ts'
import type { CardFact, HydraColumn } from '#tasks/columns-model.ts'
import type { Card, TaskStatus } from '#tasks/model.ts'

const placement = ({ card }: { card: Card }) => placeCard({
  card: cardFacts({
    card,
    state: emptyHydra(),
  }),
  columns: DEFAULT_COLUMNS,
})

const at = '2026-10-15T00:00:00Z'
const now = Date.parse('2026-10-15T02:00:00Z')
const task: Card = {
  id: 'task-test',
  key: 'test',
  title: 'Test',
  column: 'queued',
  workspace: 'unassigned',
  tags: [],
  attention: [],
  links: [],
  sourceRefs: [],
  createdSeq: 1,
  updatedSeq: 1,
  revision: 1,
  updatedAt: at,
}
const agent = {
  provider: 'claude-code',
  sessionId: 'test',
}

test(
  'worker facts follow the recorded session rather than stale card activity',
  () => {
    const card = {
      ...task,
      agent,
      sessionIds: ['claude-code:test'],
      activity: 'ended',
      sessionActivity: 'ended',
      stoppedAt: at,
    }
    const state = emptyHydra()
    state.sessions = {
      'claude-code:test': {
        id: 'claude-code:test',
        agent,
        originCardId: task.id,
        taskId: task.id,
        sessionActivity: 'working',
        attention: [],
        sourceRefs: [],
      },
    }
    assert.ok(cardFacts({
      card,
      state,
    }).includes('worker:working'))
    assert.equal(
      placeCard({
        card: cardFacts({
          card,
          state,
        }),
        columns: DEFAULT_COLUMNS,
      }),
      'in_progress',
    )
    state.sessions['claude-code:test']!.sessionActivity = 'ended'
    const staleWorking = {
      ...card,
      activity: 'working',
      sessionActivity: 'working',
      stoppedAt: undefined,
    }
    assert.ok(cardFacts({
      card: staleWorking,
      state,
    }).includes('worker:ended'))
    assert.equal(
      placeCard({
        card: cardFacts({
          card: staleWorking,
          state,
        }),
        columns: DEFAULT_COLUMNS,
      }),
      'parked',
    )
  },
)

test(
  'default column rules place cards from recorded facts',
  () => {
    const declared = ({
      state,
      hold,
    }: {
      state: TaskStatus
      hold?: boolean
    }) => ({
      id: 'status',
      at,
      actor: 'worker:test',
      state,
      note: '',
      hold,
    })
    const ownerAsk = {
      id: 'ask',
      at,
      actor: 'hydra',
      audience: 'owner' as const,
      question: 'Go?',
    }
    const held = {
      id: 'hold',
      at,
      actor: 'hydra',
      reason: 'Discuss first',
    }
    const cases: {
      name: string
      card: Partial<Card>
      column: string
      fact: CardFact
    }[] = [
      {
        name: 'not assigned',
        card: {},
        column: 'queued',
        fact: 'worker:none',
      },
      {
        name: 'assigned',
        card: { agent },
        column: 'in_progress',
        fact: 'worker:working',
      },
      {
        name: 'declared working',
        card: { status: declared({ state: 'working' }) },
        column: 'in_progress',
        fact: 'worker:working',
      },
      {
        name: 'blocked',
        card: { status: declared({ state: 'blocked' }) },
        column: 'in_progress',
        fact: 'worker:blocked',
      },
      {
        name: 'worker needs Hydra',
        card: { status: declared({ state: 'needs_you' }) },
        column: 'in_progress',
        fact: 'worker:hydra',
      },
      {
        name: 'question to Hydra',
        card: {
          agent,
          asks: [
            {
              ...ownerAsk,
              audience: 'hydra',
            },
          ],
        },
        column: 'in_progress',
        fact: 'worker:hydra',
      },
      {
        name: 'paused by owner',
        card: {
          status: declared({
            state: 'paused',
            hold: true,
          }),
        },
        column: 'parked',
        fact: 'worker:paused',
      },
      {
        name: 'worker ended unfinished',
        card: {
          agent,
          activity: 'ended',
        },
        column: 'parked',
        fact: 'worker:ended',
      },
      {
        name: 'queued behind worker',
        card: {
          queue: {
            session: 'claude:test',
            rank: 1,
          },
        },
        column: 'queued',
        fact: 'queued',
      },
      {
        name: 'discussion hold',
        card: {
          hold: held,
          status: declared({ state: 'working' }),
        },
        column: 'queued',
        fact: 'held',
      },
      {
        name: 'go question',
        card: {
          hold: held,
          asks: [ownerAsk],
        },
        column: 'needs_you',
        fact: 'owner-question',
      },
      {
        name: 'owner question',
        card: {
          status: declared({ state: 'working' }),
          asks: [ownerAsk],
        },
        column: 'needs_you',
        fact: 'owner-question',
      },
      {
        name: 'reminder due',
        card: {
          reminder: {
            id: 'reminder',
            at,
            dueAt: at,
          },
        },
        column: 'needs_you',
        fact: 'reminder-due',
      },
      {
        name: 'done declaration',
        card: { status: declared({ state: 'done' }) },
        column: 'done',
        fact: 'done',
      },
      {
        name: 'investigation report done',
        card: {
          kind: 'investigation',
          report: {
            id: 'report',
            at,
            actor: 'worker:test',
            chars: 20,
          },
          status: declared({ state: 'done' }),
        },
        column: 'done',
        fact: 'kind:investigation',
      },
      {
        name: 'waiting for checks',
        card: {
          status: declared({ state: 'paused' }),
          links: [
            {
              kind: 'github_pr',
              url: 'https://github.com/example/repo/pull/1',
              state: 'open',
              checks: '0 passed, 0 failed, 1 total',
            },
          ],
        },
        column: 'in_progress',
        fact: 'worker:checks',
      },
      {
        name: 'merged',
        card: {
          agent,
          links: [
            {
              kind: 'github_pr',
              url: 'https://github.com/example/repo/pull/1',
              state: 'merged',
            },
          ],
        },
        column: 'done',
        fact: 'pr:merged',
      },
      {
        name: 'one of two PRs merged',
        card: {
          agent,
          links: [
            {
              kind: 'github_pr',
              url: 'https://github.com/example/repo/pull/1',
              state: 'merged',
            },
            {
              kind: 'github_pr',
              url: 'https://github.com/example/repo/pull/2',
              state: 'open',
            },
          ],
        },
        column: 'in_progress',
        fact: 'pr:open',
      },
    ]

    for (const sample of cases) {
      const card = {
        ...task,
        ...sample.card,
      }
      const facts = cardFacts({
        card,
        state: emptyHydra(),
      })
      assert.ok(
        facts.includes(sample.fact),
        sample.name,
      )
      assert.equal(
        placeCard({
          card: facts,
          columns: DEFAULT_COLUMNS,
        }),
        sample.column,
        sample.name,
      )
      assert.equal(
        placeCard({
          card: facts,
          columns: [...DEFAULT_COLUMNS].reverse(),
        }),
        sample.column,
        sample.name,
      )
    }
  },
)

test(
  'custom rules match kind and PR checks, use AND/OR/NOT, and respect column order',
  () => {
    const columns: HydraColumn[] = [
      {
        id: 'custom:review',
        title: 'Review',
        rule: [
          [
            'kind:investigation',
            '!done',
          ],
          [
            'pr:green',
            '!pr:draft',
          ],
        ],
      },
      ...DEFAULT_COLUMNS,
    ]
    const sample = ({ card }: { card: Partial<Card> }) => placeCard({
      card: cardFacts({
        card: {
          ...task,
          agent,
          ...card,
        },
        state: emptyHydra(),
      }),
      columns,
    })
    assert.equal(
      sample({ card: { kind: 'investigation' } }),
      'custom:review',
    )
    assert.equal(
      sample({ card: {} }),
      'in_progress',
    )
    const link = {
      kind: 'github_pr' as const,
      url: 'https://github.com/example/repo/pull/1',
      state: 'open' as const,
      checks: '1 passed, 0 failed, 1 total',
    }
    assert.equal(
      sample({ card: { links: [link] } }),
      'custom:review',
    )
    assert.equal(
      sample({
        card: {
          links: [
            {
              ...link,
              draft: true,
            },
          ],
        },
      }),
      'in_progress',
    )
    assert.equal(
      sample({
        card: {
          links: [
            {
              ...link,
              checks: '0 passed, 1 failed, 1 total',
            },
          ],
        },
      }),
      'in_progress',
    )
    assert.equal(
      placeCard({
        card: [
          'kind:investigation',
          'worker:working',
        ],
        columns: [
          ...DEFAULT_COLUMNS,
          columns[0]!,
        ],
      }),
      'in_progress',
    )
    assert.equal(
      placeCard({
        card: ['kind:investigation'],
        columns: [
          {
            id: 'custom:manual',
            title: 'Manual',
            rule: [],
          },
        ],
      }),
      undefined,
    )
  },
)

test(
  'PR facts distinguish draft, pending, red, green, closed, and absent checks',
  () => {
    for (const [
      link,
      expected,
    ] of [
        [
          {
            state: 'open' as const,
            draft: true,
          },
          [
            'pr:open',
            'pr:draft',
          ],
        ],
        [
          {
            state: 'open' as const,
            checks: '0 passed, 0 failed, 1 total',
          },
          [
            'pr:open',
            'pr:pending',
          ],
        ],
        [
          {
            state: 'open' as const,
            checks: '1 passed, 1 failed, 2 total',
          },
          [
            'pr:open',
            'pr:red',
          ],
        ],
        [
          {
            state: 'open' as const,
            checks: '1 passed, 0 failed, 1 total',
          },
          [
            'pr:open',
            'pr:green',
          ],
        ],
        [
          {
            state: 'closed' as const,
            checks: '1 passed, 0 failed, 1 total',
          },
          ['pr:closed'],
        ],
        [
          { state: 'open' as const },
          ['pr:open'],
        ],
      ] as const) {
      const facts = cardFacts({
        card: {
          ...task,
          links: [
            {
              kind: 'github_pr',
              url: 'https://github.com/example/repo/pull/1',
              ...link,
            },
          ],
        },
        state: emptyHydra(),
      })
      assert.deepEqual(
        facts.filter(fact => fact.startsWith('pr:')).sort(),
        [...expected].sort(),
      )
    }

    const card = {
      ...task,
      outcome: {
        state: 'done' as const,
        source: 'hooks',
      },
    }
    assert.ok(
      !cardFacts({
        card,
        state: emptyHydra(),
      }).includes('done'),
      'a successful worker session is not task completion',
    )
  },
)

test(
  'cards distinguish no worker, working, finished, stopped, and unanswered asks',
  () => {
    const state = ({ card }: { card: Partial<Card> }) =>
      cardState({
        card: {
          ...task,
          ...card,
        },
        now,
      })
    assert.equal(
      state({ card: {} }).text,
      'no worker assigned',
    )
    assert.equal(
      state({
        card: {
          agent,
          activity: 'working',
        },
      }).text,
      'working',
    )
    assert.equal(
      state({
        card: {
          agent,
          activity: 'finished',
        },
      }).text,
      'activity unknown',
    )
    assert.equal(
      state({
        card: {
          agent,
          activity: 'ended',
          stoppedAt: at,
        },
      }).text,
      'stopped · 2h ago',
    )
    assert.equal(
      state({
        card: {
          attention: [
            {
              kind: 'question',
              key: 'q',
              blocking: true,
            },
          ],
        },
      }).text,
      'waiting for you',
    )
    assert.equal(
      state({
        card: {
          attention: [
            {
              kind: 'question',
              key: 'q',
              blocking: true,
              answered: 'reply',
            },
          ],
        },
      }).text,
      'no worker assigned',
    )
  },
)

test(
  'a question waiting on Hydra is not the owner\'s, and a turn cut short by a restart moves nothing',
  () => {
    const ask = ({ audience }: { audience: 'hydra' | 'owner' }) => ({
      id: 'ask-1',
      at,
      actor: 'worker:task-test',
      audience,
      question: 'Which scope?',
    })
    const shown = ({ card }: { card: Partial<Card> }) => cardState({
      card: {
        ...task,
        agent,
        ...card,
      },
      now,
    }).kind
    assert.deepEqual(
      [
        shown({
          card: {
            activity: 'finished',
            asks: [ask({ audience: 'hydra' })],
          },
        }),
        shown({
          card: {
            activity: 'working',
            asks: [ask({ audience: 'hydra' })],
          },
        }),
        shown({
          card: {
            activity: 'finished',
            asks: [ask({ audience: 'owner' })],
          },
        }),
      ],
      [
        'asks-hydra',
        'working',
        'asks',
      ],
    )
    assert.equal(
      placement({
        card: {
          ...task,
          asks: [ask({ audience: 'hydra' })],
        },
      }),
      'in_progress',
    )
    const interrupted: Card = {
      ...task,
      attention: [
        {
          kind: 'interrupted',
          key: INTERRUPTED,
          blocking: true,
        },
      ],
    }
    assert.equal(
      placement({ card: interrupted }),
      'queued',
    )
    assert.equal(
      placement({
        card: {
          ...interrupted,
          attention: [
            ...interrupted.attention,
            {
              kind: 'question',
              key: 'hook:tool:AskUserQuestion',
              blocking: true,
            },
          ],
        },
      }),
      'needs_you',
    )
  },
)

test(
  'worker needs_you and blocked notes are flags In progress, while owner gates take precedence',
  () => {
    for (const state of [
      'needs_you',
      'blocked',
    ] as const) {
      const card: Card = {
        ...task,
        status: {
          id: 'note',
          at,
          actor: 'worker:test',
          state,
          note: 'Waiting on checks',
        },
      }
      assert.equal(
        placement({ card }),
        'in_progress',
      )
      assert.equal(
        card.status?.state,
        state,
      )
      assert.equal(
        placement({
          card: {
            ...card,
            permissions: [
              {
                id: 'permission',
                session: 'test',
                status: 'pending',
                at,
                tool: 'Shell',
                input: {},
              },
            ],
          },
        }),
        'needs_you',
      )
    }
  },
)

test(
  'every prompt the owner is counted for shows in Context, with Answer when it has no controls of its own',
  () => {
    const hook = ({ key }: { key: string }) => ({
      kind: 'permission',
      key,
      blocking: true,
      text: `Allow ${key}?`,
    })
    const card = ({
      attention,
      ...rest
    }: Partial<Card>): Card => ({
      ...task,
      agent: {
        provider: 'claude-code',
        sessionId: 'test',
      },
      attention: attention ?? [],
      ...rest,
    })
    const shown = ({ card }: { card: Card }) => genericPrompts({ card })
      .map(question => question.text)

    const withAsk = card({
      attention: [hook({ key: 'hook:tool:Bash' })],
      asks: [
        {
          id: 'ask-1',
          at,
          actor: 'hydra',
          audience: 'owner',
          question: 'Choose retention?',
        },
      ],
    })
    assert.equal(
      ownerQuestions({ card: withAsk }).length,
      2,
    )
    assert.deepEqual(
      shown({ card: withAsk }),
      ['Allow hook:tool:Bash?'],
    )
    assert.deepEqual(
      shown({
        card: card({
          attention: [hook({ key: 'hook:tool:Bash' })],
          permissions: [
            {
              id: 'perm-1',
              session: 'claude-code:test',
              tool: 'Edit',
              input: {},
              status: 'pending',
            },
          ],
        }),
      }),
      ['Allow hook:tool:Bash?'],
    )
    assert.deepEqual(
      shown({
        card: card({
          attention: [
            hook({ key: 'hook:tool:Bash' }),
            hook({ key: 'hook:tool:Write' }),
          ],
        }),
      }),
      [
        'Allow hook:tool:Bash?',
        'Allow hook:tool:Write?',
      ],
    )
  },
)
