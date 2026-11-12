import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra } from '#app/reducer.ts'
import type { HydraMessage } from './model.ts'
import { receivedWith } from './received.ts'

const owner = ({ id }: { id: string }): HydraMessage => ({
  id,
  action: 'send',
  actor: 'web',
  hydra: 'hydra',
  text: id,
  at: '2026-11-12T12:00:00Z',
})

test(
  'Hydra takes with an input the owner messages that never get one of their own, but not those still on their way',
  () => {
    const state = emptyHydra()
    state.eventIds = {
      'sent-while-down': 1,
      'own-input': 2,
      'own-input:hosted': 3,
      'still-waiting': 4,
      'wake:5': 5,
      'wake:5:hosted': 6,
      'after-wake': 7,
    }
    state.hydraMessages = [
      owner({ id: 'sent-while-down' }),
      owner({ id: 'own-input' }),
      owner({ id: 'still-waiting' }),
      {
        ...owner({ id: 'worker-report' }),
        actor: 'worker:task-1',
      },
      owner({ id: 'after-wake' }),
    ]
    state.eventIds['worker-report'] = 4
    assert.deepEqual(
      receivedWith({
        state,
        input: 'wake:5',
        pending: new Set(['still-waiting']),
      }),
      ['sent-while-down'],
    )
    assert.deepEqual(
      receivedWith({
        state,
        input: 'own-input',
        pending: new Set(),
      }),
      [
        'sent-while-down',
        'own-input',
      ],
    )
  },
)
