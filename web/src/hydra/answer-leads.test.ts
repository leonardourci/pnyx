import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Ask, Card } from '#tasks/model.ts'
import type { HydraMessage } from '#hydra/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { answerLeads, questionPreview } from './answer-leads.ts'

const at = '2026-11-01T12:00:00.000Z'
const merge: Ask = {
  id: 'ask-merge',
  at,
  actor: 'pnyx',
  audience: 'owner',
  kind: 'merge',
  question: 'Ready for review: PR #148',
  options: [
    { label: 'Merge' },
    { label: 'Hold' },
  ],
}
const format: Ask = {
  id: 'ask-format',
  at,
  actor: 'hydra',
  audience: 'owner',
  question: 'Which response format?',
  options: [
    { label: 'JSON' },
    { label: 'CSV' },
  ],
  recommended: 2,
}
const card: Card = {
  id: 'task-ship',
  key: 'ship',
  title: 'Ship the export',
  column: 'needs_you',
  workspace: '',
  attention: [],
  links: [],
  tags: [],
  sourceRefs: [],
  createdSeq: 1,
  updatedSeq: 1,
  revision: 1,
  updatedAt: at,
  asks: [
    merge,
    format,
  ],
}
const message = ({ ...fields }: Partial<HydraMessage>): HydraMessage => ({
  id: `msg-${fields.text}`,
  task: card.id,
  action: 'send',
  text: '',
  at,
  actor: 'web',
  hydra: 'lab',
  ...fields,
})

test(
  'owner answers and discussions on a task carry their question, choices and pick; other messages carry none',
  () => {
    const leads = answerLeads({
      cards: { [card.id]: card },
      messages: [
        message({
          text: 'Follow up on paste separately.',
          answers: merge.id,
          choice: 'Merge',
        }),
        message({
          text: 'Highlight: this touches the chat.',
          discusses: merge.id,
        }),
        message({
          text: 'CSV, with a header row.',
          answers: format.id,
        }),
        message({ text: 'Plain message about the task.' }),
        message({
          text: 'Hydra relays an answer.',
          answers: format.id,
          actor: 'hydra',
        }),
        message({
          text: 'An answer to a forgotten question.',
          answers: 'ask-gone',
        }),
        message({
          text: 'Merge',
          answers: merge.id,
          choice: 'Merge',
        }),
        message({
          text: 'An answer to a Hydra-wide question.',
          answers: merge.id,
          task: HYDRA_CARD,
        }),
      ],
    })

    assert.deepEqual(
      Object.fromEntries(leads),
      {
        'msg-Follow up on paste separately.': {
          task: card.id,
          question: 'Ready for review: PR #148',
          options: [
            'Merge',
            'Hold',
          ],
          choice: 'Merge',
          recommended: undefined,
          discussion: false,
        },
        'msg-Highlight: this touches the chat.': {
          task: card.id,
          question: 'Ready for review: PR #148',
          options: [
            'Merge',
            'Hold',
          ],
          choice: undefined,
          recommended: undefined,
          discussion: true,
        },
        'msg-CSV, with a header row.': {
          task: card.id,
          question: 'Which response format?',
          options: [
            'JSON',
            'CSV',
          ],
          choice: undefined,
          recommended: 2,
          discussion: false,
        },
        'msg-Merge': {
          task: card.id,
          question: 'Ready for review: PR #148',
          options: [
            'Merge',
            'Hold',
          ],
          choice: 'Merge',
          recommended: undefined,
          discussion: false,
        },
      },
    )
  },
)

test(
  'a folded question previews its opening paragraph only when more follows',
  () => {
    assert.equal(
      questionPreview({ question: 'Which response format?' }),
      undefined,
    )
    assert.equal(
      questionPreview({ question: 'Rebuild **in the background**?\n\n- **Block**: simpler\n- **Background**: usable' }),
      'Rebuild **in the background**?',
    )
  },
)
