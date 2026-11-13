import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra } from '#app/reducer.ts'
import type { HydraMessage } from './model.ts'
import { receivedWith } from './received.ts'
import { recapText } from './wakes.ts'

const owner = ({ id }: { id: string }): HydraMessage => ({
  id,
  action: 'send',
  actor: 'web',
  hydra: 'hydra',
  text: id,
  at: '2026-11-12T12:00:00Z',
})

test(
  'Hydra takes with an input only that input and the owner messages it lists, never an older or a task message it does not carry',
  () => {
    const state = emptyHydra()
    state.eventIds = {
      'from-last-week': 1,
      'task-context:task-1:reply': 2,
      'sent-while-down': 3,
      'answered-already': 4,
      'answered-already:hosted': 5,
      'joins-turn': 6,
      'joins-turn:hosted': 7,
    }
    state.hydraMessages = [
      owner({ id: 'from-last-week' }),
      {
        ...owner({ id: 'task-context:task-1:reply' }),
        task: 'task-1',
      },
      owner({ id: 'sent-while-down' }),
      {
        ...owner({ id: 'worker-report' }),
        actor: 'worker:task-1',
      },
      owner({ id: 'answered-already' }),
      owner({ id: 'joins-turn' }),
    ]
    state.eventIds['worker-report'] = 3
    // A message that joins a running turn is pushed alone, so it carries none of the earlier ones.
    assert.deepEqual(
      receivedWith({
        state,
        input: 'joins-turn',
        carried: [],
      }),
      ['joins-turn'],
    )
    // The recap lists the owner's unread words after the outage began, and Hydra takes exactly those with it.
    const recap = recapText({
      state,
      since: '2026-11-12T11:00:00Z',
      after: 2,
      now: Date.parse('2026-11-12T12:00:00Z'),
    })
    assert.deepEqual(
      recap.carried,
      ['sent-while-down'],
    )
    assert.ok(recap.text.includes('sent-while-down'))
    assert.deepEqual(
      receivedWith({
        state,
        input: 'back:2',
        carried: recap.carried,
      }),
      ['sent-while-down'],
    )
  },
)
