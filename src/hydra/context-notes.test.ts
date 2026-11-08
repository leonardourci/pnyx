import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, reduce } from '#app/reducer.ts'
import type { HydraEvent } from '#app/model.ts'
import { contextNoteBlock } from './context-notes.ts'
import { eventReasons } from './wake-reasons.ts'

const at = '2026-10-20T10:00:00Z'

test(
  'routine context notes stay bounded, quiet and one line, preserving later notes after delivery',
  () => {
    let state = emptyHydra()

    for (let index = 1; index <= 21; index++) {
      const event: HydraEvent = {
        v: 1,
        id: `helper-${index}`,
        seq: index,
        at,
        actor: 'pnyx',
        cardId: '$hydra',
        type: 'hydra.helper-finished',
        data: {
          batch: `batch-${index}`,
          outcomes: [
            {
              task: 'work',
              status: 'handled',
              summary: `Result ${index}\n${'detail '.repeat(100)}`,
            },
          ],
        },
      }
      state = reduce({
        state,
        event,
      })
      assert.deepEqual(
        eventReasons({
          state,
          event,
        }),
        [],
      )
    }

    assert.equal(
      state.contextNotes?.length,
      20,
    )
    assert.ok(state.contextNotes!.every(note => note.text.length <= 400 && !note.text.includes('\n')))
    const through = state.contextNotes!.at(-2)!.seq
    state = reduce({
      state,
      event: {
        v: 1,
        id: 'consumed',
        seq: state.seq + 1,
        at,
        actor: 'pnyx',
        cardId: '$hydra',
        type: 'hydra.context-delivered',
        data: { through },
      },
    })
    assert.equal(
      state.contextNotes?.length,
      1,
    )
    assert.match(
      contextNoteBlock({ notes: state.contextNotes! }),
      /Since your last turn.*context only/,
    )
  },
)

test(
  'helper escalations and failures retain their main routing without becoming context notes',
  () => {
    let state = emptyHydra()

    for (const change of [
      {
        outcomes: [
          {
            task: 'work',
            status: 'needs_main' as const,
            summary: 'Choose a direction',
          },
        ],
      },
      {
        outcomes: [],
        error: 'Interrupted',
      },
    ]) {
      state = reduce({
        state,
        event: {
          v: 1,
          id: `batch-${state.seq}`,
          seq: state.seq + 1,
          at,
          actor: 'pnyx',
          cardId: '$hydra',
          type: 'hydra.helper-finished',
          data: {
            batch: `batch-${state.seq}`,
            ...change,
          },
        },
      })
    }

    assert.equal(
      state.contextNotes,
      undefined,
    )
  },
)

test(
  'owner notes use the escalated wording and include native question answers only once',
  () => {
    const events: HydraEvent[] = [
      {
        v: 1,
        id: 'created',
        seq: 1,
        at,
        actor: 'cli',
        cardId: 'work',
        type: 'task.created',
        data: {
          key: 'work',
          title: 'Export task',
        },
      },
      {
        v: 1,
        id: 'asked',
        seq: 2,
        at,
        actor: 'worker:work',
        cardId: 'work',
        type: 'task.asked',
        data: {
          id: 'choice',
          audience: 'hydra',
          question: 'Delete the old export?',
        },
      },
      {
        v: 1,
        id: 'escalated',
        seq: 3,
        at,
        actor: 'hydra',
        cardId: 'work',
        type: 'task.ask.escalated',
        data: {
          ask: 'choice',
          question: 'Keep the old export for compatibility?',
        },
      },
      {
        v: 1,
        id: 'answered',
        seq: 4,
        at,
        actor: 'cli',
        cardId: 'work',
        type: 'card.replied',
        data: {
          reply: 'answer',
          state: 'queued',
          route: 'pnyx',
          text: 'Yes, keep it.',
          accepted: true,
          answers: 'choice',
          decision: {
            question: 'Keep the old export for compatibility?',
            answer: 'Yes, keep it.',
          },
        },
      },
      {
        v: 1,
        id: 'native-question',
        seq: 5,
        at,
        actor: 'pnyx',
        cardId: 'work',
        type: 'task.permission',
        data: {
          id: 'native',
          session: 'worker-session',
          tool: 'AskUserQuestion',
          input: {},
          status: 'pending',
          questions: [
            {
              question: 'Which export format?',
              options: [],
            },
          ],
        },
      },
      {
        v: 1,
        id: 'native-answer',
        seq: 6,
        at,
        actor: 'cli',
        cardId: 'work',
        type: 'task.permission',
        data: {
          id: 'native',
          session: 'worker-session',
          tool: 'AskUserQuestion',
          input: {},
          status: 'allow',
          answers: [['Compact']],
        },
      },
      {
        v: 1,
        id: 'native-receipt',
        seq: 7,
        at,
        actor: 'pnyx',
        cardId: 'work',
        type: 'task.permission',
        data: {
          id: 'native',
          session: 'worker-session',
          tool: 'AskUserQuestion',
          input: {},
          status: 'allow',
          answers: [['Compact']],
          delivery: 'received',
        },
      },
    ]
    let state = emptyHydra()

    for (const event of events) {
      state = reduce({
        state,
        event,
      })
    }

    assert.deepEqual(
      state.contextNotes?.map(note => note.text),
      [
        'Owner answered Export task, "Keep the old export for compatibility?": Yes, keep it.',
        'Owner answered Export task, "Which export format?": Compact',
      ],
    )
  },
)
