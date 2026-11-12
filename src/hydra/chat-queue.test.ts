import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, reduce } from '#app/reducer.ts'
import { hydraChatQueue } from './chat-queue.ts'
import { HYDRA_CARD } from './identity.ts'

const at = '2026-11-06T00:00:00Z'

test(
  'server queue distinguishes taken messages, held inputs, reports and queued upgrades',
  () => {
    const state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'create',
        at,
        actor: 'web',
        cardId: HYDRA_CARD,
        type: 'task.created',
        data: {
          key: 'hydra',
          title: 'Hydra',
        },
      },
    })
    const card = state.cards[HYDRA_CARD]!
    card.agent = {
      provider: 'codex',
      sessionId: 'fixture',
    }
    card.activity = 'working'
    card.compaction = {
      operations: [
        {
          id: 'compact',
          session: 'codex:fixture',
          trigger: 'manual',
          state: 'running',
          startedAt: at,
        },
      ],
      inputs: [
        {
          id: 'held',
          actor: 'web',
          route: 'hydra',
          text: 'Wait for compaction',
          at,
        },
      ],
    }
    state.hydraOperation = {
      id: 'stop',
      seq: 1,
      kind: 'restart',
      since: at,
    }
    state.eventIds = {
      taken: 2,
      'taken:hosted': 3,
      held: 4,
      report: 5,
      result: 6,
    }
    state.hydraMessages = [
      {
        id: 'result',
        action: 'send',
        actor: 'pnyx',
        kind: 'routine',
        hydra: 'hydra',
        text: 'The export is ready.',
        at,
      },
      {
        id: 'taken',
        action: 'send',
        actor: 'web',
        hydra: 'hydra',
        text: 'Already read',
        at,
      },
      {
        id: 'held',
        action: 'send',
        actor: 'web',
        hydra: 'hydra',
        text: 'Wait for compaction',
        at,
      },
      {
        id: 'report',
        action: 'worker',
        actor: 'worker',
        hydra: 'hydra',
        text: 'A worker update',
        at,
      },
    ]
    state.upgrades = [
      {
        id: 'upgrade',
        state: 'queued',
        folder: '/fixture',
        queuedAt: at,
        steps: [],
      },
    ]
    const encoded = JSON.stringify(hydraChatQueue({ state }))
    const wire = JSON.parse(encoded) as ReturnType<typeof hydraChatQueue>
    assert.equal(
      wire.holding,
      true,
    )
    assert.equal(
      wire.working,
      true,
    )
    assert.equal(
      wire.compacting?.id,
      'compact',
    )
    assert.deepEqual(
      wire.held,
      [
        'held',
        'report',
      ],
    )
    assert.deepEqual(
      wire.compactInputs.map(input => input.id),
      [
        'held',
        'upgrade',
      ],
    )
    assert.deepEqual(
      wire.started,
      ['taken'],
    )
    assert.equal(
      'received' in wire,
      false,
    )
    const hosted = Array.from(
      { length: 34 },
      (
        _,
        index,
      ) => ({
        id: `owner-${index}`,
        action: 'send' as const,
        actor: 'web',
        hydra: 'hydra',
        text: 'A received owner message',
        at,
      }),
    )
    hosted.push({
      ...hosted[0]!,
      id: 'non-owner',
      actor: 'worker',
    })
    state.hydraMessages.push(...hosted)

    for (const message of hosted) {
      state.eventIds[`${message.id}:hosted`] = 10
    }

    assert.deepEqual(
      hydraChatQueue({ state }).started,
      [
        'owner-2',
        'owner-3',
        'owner-4',
        'owner-5',
        'owner-6',
        'owner-7',
        'owner-8',
        'owner-9',
        'owner-10',
        'owner-11',
        'owner-12',
        'owner-13',
        'owner-14',
        'owner-15',
        'owner-16',
        'owner-17',
        'owner-18',
        'owner-19',
        'owner-20',
        'owner-21',
        'owner-22',
        'owner-23',
        'owner-24',
        'owner-25',
        'owner-26',
        'owner-27',
        'owner-28',
        'owner-29',
        'owner-30',
        'owner-31',
        'owner-32',
        'owner-33',
      ],
    )
    card.compaction = {
      operations: [],
      inputs: [],
    }
    delete state.hydraOperation
    state.upgrades = []
    const released = hydraChatQueue({ state })
    assert.equal(
      released.holding,
      false,
    )
    assert.deepEqual(
      released.held,
      [],
    )
    assert.deepEqual(
      released.compactInputs,
      [],
    )
  },
)
