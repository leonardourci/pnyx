import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decisionsBlock } from './decisions.ts'
import type { HydraState } from '#app/model.ts'
import type { Ask, Card } from './model.ts'
import { taskMention } from '#hydra/mentions.ts'

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
