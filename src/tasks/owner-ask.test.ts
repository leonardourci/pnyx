import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ownerAsk, taskInstructions } from './intent.ts'
import { emptyHydra, replay } from '../app/reducer.ts'
import type { HydraEvent } from '../app/model.ts'

const at = '2026-10-01T00:00:00Z'
const create: HydraEvent = {
  v: 1,
  boardId: 'test',
  id: 'create',
  seq: 1,
  at,
  actor: 'hydra',
  cardId: 'task',
  type: 'task.created',
  data: {
    key: 'task',
    title: 'Repair',
    brief: 'Try a minimal fix',
    ask: {
      text: 'Fix the save button',
      at,
      actor: 'web',
    },
  },
}

test(
  'later owner words survive brief rewrites and Hydra reports never become the ask',
  () => {
    const events: HydraEvent[] = [
      create,
      {
        v: 1,
        boardId: 'test',
        id: 'owner',
        seq: 2,
        at,
        actor: 'web',
        cardId: 'task',
        type: 'hydra.message',
        data: {
          task: 'task',
          hydra: 'test',
          action: 'send',
          text: 'Keep keyboard saving too',
        },
      },
      {
        v: 1,
        boardId: 'test',
        id: 'report',
        seq: 3,
        at,
        actor: 'hydra',
        cardId: 'task',
        type: 'hydra.message',
        data: {
          task: 'task',
          hydra: 'test',
          action: 'send',
          text: 'Add a subsystem',
        },
      },
      {
        v: 1,
        boardId: 'test',
        id: 'brief',
        seq: 4,
        at,
        actor: 'hydra',
        cardId: 'task',
        type: 'task.brief',
        data: {
          before: 'Try a minimal fix',
          after: 'Use a regression test',
        },
      },
    ]
    const state = replay({
      state: emptyHydra(),
      events,
    })
    const card = state.cards.task!
    assert.deepEqual(
      card.ask?.map(entry => entry.text),
      [
        'Fix the save button',
        'Keep keyboard saving too',
      ],
    )
    assert.equal(
      card.brief,
      'Use a regression test',
    )
    const prompt = taskInstructions({ card })
    assert.ok(prompt.indexOf("Owner's ask:") < prompt.indexOf("Hydra's build instructions:"))
    assert.ok(prompt.includes('Keep keyboard saving too'))
  },
)

test(
  'Hydra can quote saved owner words but cannot invent or rewrite them',
  () => {
    const state = emptyHydra()
    state.hydraMessages = [
      {
        id: 'owner',
        text: 'Fix saving, keep shortcuts',
        at,
        actor: 'web',
        hydra: 'test',
        action: 'send',
      },
    ]
    assert.throws(
      () => ownerAsk({
        state,
        text: 'Add monitoring',
        actor: 'hydra',
        at,
      }),
      { code: 'OWNER_ONLY' },
    )
    assert.throws(
      () => ownerAsk({
        state,
        text: 'Add monitoring',
        message: 'owner',
        actor: 'hydra',
        at,
      }),
      { code: 'ASK_SOURCE_MISMATCH' },
    )
    assert.deepEqual(
      ownerAsk({
        state,
        text: 'keep shortcuts',
        message: 'owner',
        actor: 'hydra',
        at: 'later',
      }),
      {
        text: 'keep shortcuts',
        message: 'owner',
        actor: 'web',
        at,
      },
    )
  },
)
