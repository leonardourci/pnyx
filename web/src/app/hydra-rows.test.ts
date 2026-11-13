import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hydraFromRows, type CardRow, type HydraRow, type ReferenceRow } from './hydra-rows.ts'

const card = {
  hydra_id: 'h',
  id: 'task-1',
  key: 'ship',
  title: 'Ship it',
  column_id: 'working',
  hidden: false,
  automatic_task: false,
  open_permissions: 0,
  created_seq: 1,
  updated_seq: 7,
  updated_at: '2026-11-13T00:00:00.000Z',
  child_working: false,
  unmet_prerequisites: [],
}

const boardRow = {
  ...card,
  body: {
    hydra_id: 'h',
    card_id: 'task-1',
    data: {
      id: 'task-1',
      key: 'ship',
      title: 'Ship it',
      column: 'working',
      workspace: '/w',
      tags: ['web'],
      attention: [],
      sourceRefs: [],
      revision: 3,
      createdSeq: 1,
      updatedSeq: 7,
      updatedAt: '2026-11-13T00:00:00.000Z',
      brief: 'Ship the page',
    },
  },
  questions: [
    {
      data: {
        id: 'ask-2',
        question: 'Second?',
      },
    },
    {
      data: {
        id: 'ask-1',
        question: 'First?',
      },
    },
  ],
  declarations: [],
  links: [
    {
      url: 'https://github.com/o/r/pull/1',
      data: {
        kind: 'github_pr',
        url: 'https://github.com/o/r/pull/1',
        number: 1,
      },
      mergeQuestion: {
        card_id: 'task-1',
        data: { id: 'ask-1' },
        card: { id: 'task-1' },
      },
    },
    {
      url: 'https://github.com/o/r/pull/2',
      data: {
        kind: 'github_pr',
        url: 'https://github.com/o/r/pull/2',
        number: 2,
      },
      mergeQuestion: {
        card_id: 'task-2',
        data: { id: 'ask-9' },
        card: {
          id: 'task-2',
          key: 'old',
          title: 'Old work',
          column_id: 'done',
          hidden: true,
          automatic_task: false,
          created_seq: 2,
          updated_seq: 3,
          updated_at: '2026-11-13T00:00:00.000Z',
        },
      },
    },
  ],
} as unknown as CardRow

const hydra = {
  id: 'h',
  seq: 7,
  config: { name: 'Hydra' },
  columns: [
    {
      data: {
        id: 'needs_you',
        title: 'Needs you',
      },
    },
    {
      data: {
        id: 'working',
        title: 'Working',
      },
    },
  ],
  values: [
    {
      key: 'configRevision',
      value: 4,
    },
    {
      key: 'labelColors',
      value: [
        {
          label: 'web',
          color: 'blue',
        },
      ],
    },
  ],
} as unknown as HydraRow

const references = [
  card,
  {
    ...card,
    id: 'task-2',
    key: 'old',
    title: 'Old work',
    hidden: true,
  },
  {
    ...card,
    id: 'session-1',
    key: 'session',
    title: 'A session',
    automatic_task: true,
  },
] as unknown as ReferenceRow[]

test(
  'the page state built from Zero rows shows each board card whole and names hidden tasks by reference',
  () => {
    const state = hydraFromRows({
      hydra,
      cards: [boardRow],
      opened: [],
      references,
    })

    assert.equal(
      state.seq,
      7,
    )
    assert.equal(
      state.configRevision,
      4,
    )
    assert.deepEqual(
      state.config?.columns.map(column => column.id),
      [
        'needs_you',
        'working',
      ],
    )
    assert.equal(
      state.cards['task-1']?.brief,
      'Ship the page',
    )
    assert.deepEqual(
      state.cards['task-1']?.asks?.map(ask => ask.id),
      [
        'ask-2',
        'ask-1',
      ],
    )
    assert.equal(
      state.cards['task-1']?.statusLog,
      undefined,
    )
    assert.equal(
      state.cards['task-1']?.links[0]?.number,
      1,
    )
    const decided = state.cards['task-1']?.facts?.mergeQuestions
    assert.equal(
      decided?.['https://github.com/o/r/pull/1']?.card,
      undefined,
      'a question on the card itself names no other card',
    )
    assert.equal(
      decided?.['https://github.com/o/r/pull/2']?.card?.title,
      'Old work',
    )
    assert.deepEqual(
      Object.keys(state.references ?? {}),
      ['task-2'],
    )
    assert.equal(
      state.references?.['task-2']?.title,
      'Old work',
    )
    assert.deepEqual(
      state.keys,
      {
        ship: 'task-1',
        old: 'task-2',
        session: 'session-1',
      },
    )
  },
)

test(
  'an unchanged row keeps its card, so the board does not redraw it',
  () => {
    const build = () => hydraFromRows({
      hydra,
      cards: [boardRow],
      opened: [],
      references,
    })

    assert.equal(
      build().cards['task-1'],
      build().cards['task-1'],
    )
  },
)

test(
  'a list the server stored empty stays empty on the card, and one the card never had stays missing',
  () => {
    const state = hydraFromRows({
      hydra,
      cards: [
        {
          ...boardRow,
          body: {
            ...boardRow.body,
            data: {
              ...boardRow.body?.data,
              statusLog: [],
            },
          },
          questions: [],
        } as unknown as CardRow,
      ],
      opened: [],
      references,
    })

    assert.deepEqual(
      state.cards['task-1']?.statusLog,
      [],
    )
    assert.equal(
      state.cards['task-1']?.asks,
      undefined,
    )
  },
)
