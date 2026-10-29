import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cardStatus, currentState, statusLabel, waitingQuestions } from './card-status.ts'
import { permissionAttention } from '#workers/permission-rules.ts'
import { emptyHydra, replay } from '#app/reducer.ts'
import type { HydraEvent } from '#app/model.ts'
import { INTERRUPTED } from '#workers/session-attachments.ts'
import type { Ask, Card, TaskDeclaration, TaskStatus } from './model.ts'
import type { Reply, ReplyState } from '#workers/model.ts'

const at = '2026-10-15T00:00:00Z'
const later = '2026-10-15T01:00:00Z'
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

const word = ({ card }: { card: Partial<Card> }) => statusLabel({
  status: cardStatus({
    card: {
      ...task,
      agent,
      activity: 'finished',
      ...card,
    },
  }),
})

const ask = ({
  id,
  ...rest
}: { id: string } & Partial<Ask>): Ask => ({
  id,
  at,
  actor: 'hydra',
  audience: 'owner',
  question: `Question ${id}?`,
  ...rest,
})

const reply = ({
  answers,
  state,
}: {
  answers: string
  state: ReplyState
}): Reply => ({
  id: `reply-${answers}-${state}`,
  state,
  answers,
})

const declared = ({
  state,
  actor = 'worker:task-test',
  note = `${state} note`,
  when = at,
}: {
  state: TaskStatus
  actor?: string
  note?: string
  when?: string
}): TaskDeclaration => ({
  id: `evt-${state}-${actor}`,
  at: when,
  actor,
  state,
  note,
})

test(
  'every question waiting on the owner counts, and an answer on its way shows its delivery',
  () => {
    const two = [
      ask({ id: 'ask-1' }),
      ask({ id: 'ask-2' }),
    ]

    assert.equal(
      word({ card: { asks: two } }),
      'Needs you · 2',
    )
    assert.equal(
      word({
        card: {
          asks: two,
          replies: [
            reply({
              answers: 'ask-1',
              state: 'queued',
            }),
          ],
        },
      }),
      'Needs you',
      'an unanswered question outranks one whose answer is sending, which leaves the count',
    )
    assert.deepEqual(
      [
        'queued',
        'delivery_unknown',
        'failed',
      ].map(state => word({
        card: {
          asks: [ask({ id: 'ask-1' })],
          replies: [
            reply({
              answers: 'ask-1',
              state: state as ReplyState,
            }),
          ],
        },
      })),
      [
        'Answer sending',
        'Answer delivery uncertain',
        'Answer not sent',
      ],
    )
    assert.equal(
      word({
        card: {
          asks: two,
          replies: [
            reply({
              answers: 'ask-1',
              state: 'queued',
            }),
            reply({
              answers: 'ask-2',
              state: 'delivery_unknown',
            }),
          ],
        },
      }),
      'Answer delivery uncertain',
      'a delivery that may have failed says more than one still sending',
    )
    assert.equal(
      word({
        card: {
          asks: [ask({ id: 'ask-1' })],
          replies: [
            reply({
              answers: 'ask-1',
              state: 'failed',
            }),
            reply({
              answers: 'ask-1',
              state: 'queued',
            }),
          ],
        },
      }),
      'Answer sending',
      'the newest receipt wins',
    )
  },
)

test(
  'a permission counts once, and an interrupted turn is no question',
  () => {
    const card: Card = {
      ...task,
      agent,
      permissions: [
        {
          id: 'perm-1',
          session: 'claude-code:test',
          tool: 'Bash',
          input: {},
          status: 'pending',
        },
      ],
      attention: [
        {
          kind: 'interrupted',
          key: INTERRUPTED,
          blocking: true,
          text: 'The session was interrupted.',
        },
      ],
    }
    permissionAttention({ card })

    assert.equal(
      waitingQuestions({ card }).length,
      1,
    )
    assert.equal(
      word({ card }),
      'Needs you',
    )
    assert.equal(
      word({
        card: {
          attention: card.attention.filter(prompt => prompt.key === INTERRUPTED),
        },
      }),
      'Finished its turn',
    )
  },
)

test(
  'a due reminder needs the owner, and a queued task without a worker says so',
  () => {
    assert.equal(
      word({
        card: {
          reminder: {
            id: 'rem-1',
            at,
            dueAt: at,
          },
        },
      }),
      'Needs you',
    )
    assert.equal(
      statusLabel({
        status: cardStatus({
          card: {
            ...task,
            queue: {
              session: 'claude-code:other',
              rank: 1,
            },
          },
        }),
      }),
      'Queued',
    )
  },
)

test(
  'a worker\'s own wait shows until it works again, asks Hydra something newer or the owner answers',
  () => {
    assert.deepEqual(
      [
        'needs_you',
        'blocked',
        'paused',
      ].map(state => word({ card: { status: declared({ state: state as TaskStatus }) } })),
      [
        'Waiting on a decision',
        'Blocked',
        'Paused',
      ],
    )
    assert.equal(
      word({
        card: {
          activity: 'working',
          turnStartedAt: later,
          status: declared({ state: 'paused' }),
        },
      }),
      'Working',
    )
    assert.equal(
      word({
        card: {
          status: declared({ state: 'blocked' }),
          asks: [
            ask({
              id: 'ask-hydra',
              audience: 'hydra',
              at: later,
            }),
          ],
        },
      }),
      'Asks Hydra',
    )
    assert.equal(
      word({
        card: {
          status: declared({ state: 'blocked' }),
          asks: [
            ask({
              id: 'ask-hydra',
              audience: 'hydra',
              at: later,
              answered: 'r1',
              answeredAt: later,
            }),
          ],
        },
      }),
      'Finished its turn',
      'Hydra answering the newer question does not bring the old wait back',
    )
    assert.equal(
      word({
        card: {
          status: declared({ state: 'needs_you' }),
          asks: [
            ask({
              id: 'ask-1',
              answered: 'r1',
              answeredAt: later,
            }),
          ],
        },
      }),
      'Finished its turn',
    )
  },
)

test(
  'a worker\'s wait stays cleared after the newer turn ends',
  () => {
    let seq = 0
    const event = ({
      at: when,
      actor = 'cli',
      ...rest
    }: {
      at: string
      actor?: string
    } & Pick<HydraEvent, 'type' | 'data'>) => ({
      v: 1,
      seq: ++seq,
      id: `evt_${seq}`,
      at: when,
      actor,
      cardId: 'c1',
      ...rest,
    }) as HydraEvent
    const turn = ({
      at: when,
      activity,
    }: {
      at: string
      activity: 'working' | 'finished'
    }) => event({
      at: when,
      type: 'card.pushed',
      data: {
        key: 'claude:test',
        agent: {
          ...agent,
          cwd: '/lab',
        },
        activity,
        source: {
          adapter: 'hooks',
          instanceId: 'claude',
          objectId: 'test',
          observedAt: when,
        },
      },
    } as Pick<HydraEvent, 'type' | 'data'> & { at: string })
    const blocked = [
      turn({
        at: '2026-10-29T09:55:00Z',
        activity: 'working',
      }),
      event({
        at: '2026-10-29T10:00:00Z',
        actor: 'worker:c1',
        type: 'task.declared',
        data: {
          state: 'blocked',
          note: 'Waiting on the API key.',
        },
      } as Pick<HydraEvent, 'type' | 'data'> & {
        at: string
        actor: string
      }),
      turn({
        at: '2026-10-29T10:01:00Z',
        activity: 'finished',
      }),
    ]
    const status = ({ events }: { events: HydraEvent[] }) => statusLabel({
      status: cardStatus({
        card: replay({
          state: emptyHydra(),
          events,
        }).cards.c1!,
      }),
    })

    assert.equal(
      status({ events: blocked }),
      'Blocked',
    )
    assert.equal(
      status({
        events: [
          ...blocked,
          turn({
            at: '2026-10-29T11:00:00Z',
            activity: 'working',
          }),
          turn({
            at: '2026-10-29T11:01:00Z',
            activity: 'finished',
          }),
        ],
      }),
      'Finished its turn',
    )
  },
)

test(
  'Pnyx\'s own declarations and a column\'s creation default are not a worker\'s wait',
  () => {
    for (const status of [
      declared({
        state: 'paused',
        actor: 'hydra',
        note: '',
      }),
      declared({
        state: 'paused',
        actor: 'cli',
        note: '',
      }),
      declared({
        state: 'needs_you',
        actor: 'pnyx',
        note: 'Reminder fired',
      }),
      declared({
        state: 'paused',
        actor: 'pnyx',
        note: 'Worker detached',
      }),
    ]) {
      assert.equal(
        word({ card: { status } }),
        'Finished its turn',
        `${status.actor}: ${status.note}`,
      )
    }

    assert.equal(
      statusLabel({ status: cardStatus({ card: task }) }),
      'No worker assigned',
    )
  },
)

test(
  'the current state is the worker\'s newest note or progress report, never Pnyx\'s own declarations',
  () => {
    const progress = {
      text: 'Tests pass; opening the pull request.',
      at: '2026-10-15T00:20:00Z',
      actor: 'worker:task-test',
    }
    const card: Card = {
      ...task,
      statusLog: [
        declared({
          state: 'working',
          note: 'Building the redirect.',
        }),
        declared({
          state: 'needs_you',
          actor: 'pnyx',
          note: 'Pull request ready for owner review',
          when: '2026-10-15T00:30:00Z',
        }),
      ],
      progress,
    }

    assert.deepEqual(
      currentState({ card }),
      {
        text: progress.text,
        at: progress.at,
        source: 'progress',
      },
    )
    assert.deepEqual(
      currentState({
        card: {
          ...card,
          statusLog: [
            declared({
              state: 'blocked',
              note: 'Waiting on the API key.',
              when: later,
            }),
          ],
        },
      }),
      {
        text: 'Waiting on the API key.',
        at: later,
        source: 'note',
      },
    )
  },
)
