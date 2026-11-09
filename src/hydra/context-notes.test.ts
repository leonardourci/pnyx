import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, reduce } from '#app/reducer.ts'
import type { HydraEvent } from '#app/model.ts'
import { contextNoteBlock, contextTurnNotes } from './context-notes.ts'
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
              task: `work-${index}`,
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
      contextNoteBlock({
        notes: state.contextNotes!,
        hydraId: 'fixture',
      }),
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

    for (let index = 0; index < 25; index++) {
      state = reduce({
        state,
        event: {
          v: 1,
          id: `routine-${index}`,
          seq: state.seq + 1,
          at,
          actor: 'pnyx',
          cardId: '$hydra',
          type: 'hydra.helper-finished',
          data: {
            batch: `routine-${index}`,
            outcomes: [
              {
                task: index === 0 ? 'work' : `other-${index}`,
                status: 'handled',
                summary: 'The task finished.',
              },
            ],
          },
        },
      })
    }

    assert.deepEqual(
      state.contextNotes?.filter(note => note.ownerAnswer).map(note => note.text),
      [
        'Owner answered Export task, "Keep the old export for compatibility?": Yes, keep it.',
        'Owner answered Export task, "Which export format?": Compact',
      ],
    )
    assert.equal(
      state.contextNotes?.length,
      22,
    )
    const block = contextNoteBlock({
      notes: state.contextNotes!,
      hydraId: 'fixture',
    })
    assert.match(
      block,
      /Yes, keep it/,
    )
    assert.match(
      block,
      /Compact/,
    )
  },
)

test(
  'unchanged waits never become notes and only the newest routine change per task remains',
  () => {
    let state = emptyHydra()

    const finish = ({
      id,
      status,
      summary,
    }: {
      id: string
      status: 'handled' | 'still_waiting'
      summary: string
    }) => {
      state = reduce({
        state,
        event: {
          v: 1,
          id,
          seq: state.seq + 1,
          at,
          actor: 'pnyx',
          cardId: '$hydra',
          type: 'hydra.helper-finished',
          data: {
            batch: id,
            outcomes: [
              {
                task: 'work',
                status,
                summary,
              },
            ],
          },
        },
      })
    }

    finish({
      id: 'working',
      status: 'still_waiting',
      summary: 'Still working.',
    })
    finish({
      id: 'waiting',
      status: 'still_waiting',
      summary: 'Still waiting on checks.',
    })
    finish({
      id: 'unchanged',
      status: 'still_waiting',
      summary: 'No new request.',
    })
    assert.deepEqual(
      state.contextNotes ?? [],
      [],
    )
    finish({
      id: 'ready',
      status: 'handled',
      summary: 'The task became ready.',
    })
    finish({
      id: 'failed',
      status: 'handled',
      summary: 'The task failed validation.',
    })
    assert.deepEqual(
      state.contextNotes?.map(note => note.text),
      ['Routine helper, work: The task failed validation.'],
    )
    finish({
      id: 'finished',
      status: 'handled',
      summary: 'The task finished.',
    })
    finish({
      id: 'repeat',
      status: 'handled',
      summary: 'The task finished.',
    })
    assert.deepEqual(
      state.contextNotes?.map(note => note.id),
      ['finished:work'],
    )
  },
)

test(
  'context turns cap lines, point overflow to history and acknowledge only the notes shown',
  () => {
    const notes = Array.from(
      { length: 10 },
      (
        _,
        index,
      ) => ({
        id: `note-${index}`,
        seq: 10,
        text: `Task ${index} finished.`,
        task: `task-${index}`,
      }),
    )
    const block = contextNoteBlock({
      notes,
      hydraId: 'fixture',
    })
    assert.equal(
      block.split('\n').filter(text => text.startsWith('- ')).length,
      8,
    )
    assert.match(
      block,
      /and 3 more; read `pnyx-axi hydra history --hydra fixture --since origin --through 10 --budget 6000`/,
    )
    assert.doesNotMatch(
      block,
      /Task 7 finished/,
    )
    const shown = contextTurnNotes({ notes })
    const state = reduce({
      state: {
        ...emptyHydra(),
        contextNotes: notes,
      },
      event: {
        v: 1,
        id: 'delivered',
        seq: 11,
        at,
        actor: 'pnyx',
        cardId: '$hydra',
        type: 'hydra.context-delivered',
        data: {
          through: shown.at(-1)!.seq,
          ids: shown.map(note => note.id),
        },
      },
    })
    assert.deepEqual(
      state.contextNotes?.map(note => note.id),
      [
        'note-7',
        'note-8',
        'note-9',
      ],
    )
    assert.match(
      contextNoteBlock({
        notes: state.contextNotes!,
        hydraId: 'fixture',
      }),
      /Task 7 finished/,
    )
    assert.equal(
      contextNoteBlock({
        notes: [],
        hydraId: 'fixture',
      }),
      '',
    )
  },
)
