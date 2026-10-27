import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decisionsBlock, openDecisions } from '../src/core/decisions.ts'
import { HYDRA_CARD } from '../src/core/hydra.ts'
import { PERMISSION_PREFIX } from '../src/core/permissions.ts'
import type { Ask, Card, Link } from '../src/core/model.ts'
import type { HydraState } from '../src/app/model.ts'
import { INTERRUPTED } from '../src/core/tasks.ts'
import { taskMention } from '../src/mentions/mentions.ts'

const PR = 'https://github.com/o/r/pull/7'
const now = Date.parse('2026-10-23T12:00:00.000Z')

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

const hydraState = ({
  cards,
  projects,
}: {
  cards: Card[]
  projects?: HydraState['projects']
}): HydraState => ({
  seq: 100,
  cards: Object.fromEntries(cards.map(c => [
    c.id,
    c,
  ])),
  keys: {},
  eventIds: {},
  projects,
}) as unknown as HydraState

const ask = ({
  id,
  ...fields
}: Partial<Ask> & { id: string }): Ask => ({
  id,
  at: '2026-10-23T11:00:00.000Z',
  actor: 'hydra',
  audience: 'owner',
  question: `Question ${id}?`,
  ...fields,
})

const pr = ({ checks }: { checks?: string }): Link => ({
  kind: 'github_pr',
  url: PR,
  state: 'open',
  ...(checks ? { checks } : {}),
})

const lines = ({ state }: { state: HydraState }) => openDecisions({ state }).map(d => `${d.card.id} ${d.kind}: ${d.detail}`)

test(
  'every kind waiting on someone is listed, and an answered or closed one is not',
  () => {
    const state = hydraState({
      cards: [
        card({
          id: 'owner',
          asks: [
            ask({
              id: 'ask-1',
              options: [
                { label: 'Merge' },
                { label: 'Hold' },
              ],
              recommended: 1,
            }),
            ask({
              id: 'ask-2',
              answered: 'evt_9',
            }),
          ],
        }),
        card({
          id: 'worker',
          asks: [
            ask({
              id: 'ask-3',
              audience: 'hydra',
              actor: 'worker:worker',
            }),
          ],
        }),
        card({
          id: 'tool',
          permissions: [
            {
              id: 'perm-1',
              session: 's',
              tool: 'Bash',
              input: {},
              status: 'pending',
              at: '2026-10-23T11:00:00.000Z',
            },
            {
              id: 'perm-2',
              session: 's',
              tool: 'Write',
              input: {},
              status: 'allow',
            },
            {
              id: 'perm-3',
              session: 's',
              tool: 'AskUserQuestion',
              input: {},
              status: 'pending',
              at: '2026-10-23T11:00:00.000Z',
              questions: [
                {
                  question: 'Which port?',
                  options: [],
                },
              ],
            },
          ],
          // A pending permission also shows as attention; it is listed once.
          attention: [
            {
              kind: 'permission',
              key: `${PERMISSION_PREFIX}perm-1`,
              blocking: true,
              text: 'Bash',
            },
          ],
        }),
        card({
          id: 'prompt',
          attention: [
            {
              kind: 'question',
              key: 'hook:1',
              blocking: true,
              text: 'Which database?',
            },
            {
              kind: 'question',
              key: 'hook:2',
              blocking: true,
              text: 'Answered already',
              answered: 'evt_8',
            },
            {
              kind: 'interrupted',
              key: INTERRUPTED,
              blocking: true,
            },
            {
              kind: 'note',
              key: 'hook:3',
              blocking: false,
              text: 'Not blocking',
            },
            {
              kind: 'question',
              key: 'hook:4',
              blocking: true,
              questions: [],
            },
          ],
        }),
        // Sessions no task owns, and cards retention hid, are never Hydra's to decide.
        card({
          id: 'outside',
          automaticTask: true,
          asks: [ask({ id: 'ask-5' })],
          attention: [
            {
              kind: 'permission',
              key: 'hook:tool:Bash',
              blocking: true,
              text: 'Bash',
            },
          ],
        }),
        card({
          id: 'gone',
          hidden: true,
          asks: [ask({ id: 'ask-6' })],
        }),
        // Hydra's own card is never a decision Hydra is told about.
        card({
          id: HYDRA_CARD,
          asks: [ask({ id: 'ask-4' })],
        }),
      ],
    })

    assert.deepEqual(
      lines({ state }).sort(),
      [
        'owner owner question: ask-1 "Question ask-1?" (recommended: Merge)',
        'prompt blocking prompt: "Which database?"',
        'prompt blocking prompt: "question"',
        'tool permission: perm-1 Bash',
        'tool permission: perm-3 AskUserQuestion "Which port?"',
        'worker worker question: ask-3 to you "Question ask-3?"',
      ],
    )
  },
)

test(
  'an escalated question shows the owner wording and waits from its escalation',
  () => {
    const state = hydraState({
      cards: [
        card({
          id: 'fix',
          asks: [
            ask({
              id: 'ask-1',
              audience: 'owner',
              actor: 'worker:fix',
              question: 'Which port?',
              escalated: {
                id: 'evt_5',
                at: '2026-10-23T11:30:00.000Z',
                actor: 'hydra',
                question: 'Should the server move to port 80?',
              },
            }),
          ],
        }),
      ],
    })

    assert.deepEqual(
      openDecisions({ state }).map(d => [
        d.kind,
        d.at,
        d.detail,
      ]),
      [
        [
          'owner question',
          '2026-10-23T11:30:00.000Z',
          'ask-1 "Should the server move to port 80?"',
        ],
      ],
    )
  },
)

test(
  'an approved merge is listed until it merges, with its checks',
  () => {
    const projects = [
      {
        path: '/p/pnyx',
        name: 'pnyx',
        detached: false,
        merge: 'hydra' as const,
      },
    ]
    const withLink = ({
      link,
      status,
    }: {
      link: Link
      status?: Card['status']
    }) => hydraState({
      projects,
      cards: [
        card({
          id: 'fix',
          project: '/p/pnyx',
          links: [link],
          ...(status ? { status } : {}),
        }),
      ],
    })

    assert.deepEqual(
      lines({ state: withLink({ link: pr({ checks: '1 passed, 1 pending, 2 total' }) }) }),
      [`fix approved merge: ${PR} waits on checks (1 passed, 1 pending, 2 total)`],
    )
    assert.deepEqual(
      lines({ state: withLink({ link: pr({ checks: '1 passed, 1 failed, 2 total' }) }) }),
      [`fix approved merge: ${PR} checks red (1 passed, 1 failed, 2 total)`],
    )
    assert.deepEqual(
      lines({ state: withLink({ link: pr({ checks: '2 passed, 2 total' }) }) }),
      [`fix approved merge: ${PR} checks green: merge it (2 passed, 2 total)`],
    )
    assert.deepEqual(
      lines({ state: withLink({ link: pr({}) }) }),
      [`fix approved merge: ${PR} waits on checks`],
    )

    for (const state of [
      withLink({
        link: {
          ...pr({ checks: '2 passed, 2 total' }),
          state: 'merged',
        },
      }),
      withLink({
        link: {
          ...pr({}),
          draft: true,
        },
      }),
      withLink({
        link: pr({}),
        status: {
          state: 'working',
          at: '2026-10-23T11:00:00.000Z',
        } as Card['status'],
      }),
      hydraState({
        projects: [
          {
            ...projects[0]!,
            merge: 'owner',
          },
        ],
        cards: [
          card({
            id: 'fix',
            project: '/p/pnyx',
            links: [pr({})],
          }),
        ],
      }),
    ]) {
      assert.deepEqual(
        openDecisions({ state }),
        [],
      )
    }
  },
)

test(
  'the block lists items oldest first with their age, then those with no time, and says none when nothing waits',
  () => {
    assert.equal(
      decisionsBlock({
        state: hydraState({ cards: [card({ id: 'idle' })] }),
        now,
      }),
      'Open decisions: none',
    )

    const state = hydraState({
      cards: [
        card({
          id: 'new',
          asks: [
            ask({
              id: 'ask-new',
              at: '2026-10-23T11:59:30.000Z',
            }),
          ],
        }),
        card({
          id: 'old',
          asks: [
            ask({
              id: 'ask-old',
              at: '2026-10-23T08:00:00.000Z',
            }),
          ],
        }),
        card({
          id: 'mid',
          asks: [
            ask({
              id: 'ask-mid',
              audience: 'hydra',
              actor: 'worker:mid',
              at: '2026-10-23T11:15:00.000Z',
            }),
          ],
        }),
        card({
          id: 'prompt',
          attention: [
            {
              kind: 'question',
              key: 'hook:1',
              blocking: true,
              text: 'Which database?',
            },
          ],
        }),
        card({
          id: 'hour',
          asks: [
            ask({
              id: 'ask-hour',
              at: '2026-10-23T10:30:00.000Z',
            }),
          ],
        }),
        card({
          id: 'hours',
          asks: [
            ask({
              id: 'ask-hours',
              at: '2026-10-23T09:30:00.000Z',
            }),
          ],
        }),
      ],
    })
    const mention = ({ id }: { id: string }) => taskMention({
      id,
      title: `Task ${id}`,
    })

    assert.equal(
      decisionsBlock({
        state,
        now,
      }),
      [
        'Open decisions (6):',
        `- ${mention({ id: 'old' })} owner question, 4 h old: ask-old "Question ask-old?"`,
        `- ${mention({ id: 'hours' })} owner question, 2 h old: ask-hours "Question ask-hours?"`,
        `- ${mention({ id: 'hour' })} owner question, 90 min old: ask-hour "Question ask-hour?"`,
        `- ${mention({ id: 'mid' })} worker question, 45 min old: ask-mid to you "Question ask-mid?"`,
        `- ${mention({ id: 'new' })} owner question, under 1 min old: ask-new "Question ask-new?"`,
        `- ${mention({ id: 'prompt' })} blocking prompt: "Which database?"`,
      ].join('\n'),
    )
  },
)
