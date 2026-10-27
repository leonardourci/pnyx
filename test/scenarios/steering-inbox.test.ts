import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Card } from '../../src/core/model.ts'
import { emptyHydra, replay } from '../../src/core/reducer.ts'
import { hydraDir } from '../../src/store/hydra-store.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

const pending = ({ card }: { card: Card }) => {
  const messages = card.steering ?? []

  return messages.filter(message => !message.ack).map(message => message.id)
}

const claimFlags = ({ card }: { card: Card }) => [
  '--session',
  card.sessionIds![0]!,
  '--generation',
  String(card.steeringGeneration ?? card.createdSeq),
]

test(
  'ordered instructions, notification receipts and acknowledgements survive restart and replay',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'worker' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Work',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'work',
      ],
    })
    const worker = s.as({ agent: await s.agent({ cwd: folder }) })
    await until({
      what: 'the opening worker turn to finish',
      check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
    })
    const text = 'Olá 🌊\nKeep every line.\n第二行'
    await s.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'work',
        'first',
        '--source',
        'owner',
        '--reply',
        'reply-1',
        '--file',
        '-',
      ],
      input: text,
    })
    await s.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'work',
        'first',
        '--source',
        'owner',
        '--reply',
        'reply-1',
        '--text',
        text,
      ],
    })
    await s.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'work',
        'second',
        '--text',
        text,
      ],
    })
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'inbox',
          'enqueue',
          'work',
          'first',
          '--text',
          'changed',
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.deepEqual(
      pending({ card: s.task({ key: 'work' }) }),
      [
        'first',
        'second',
      ],
    )
    assert.deepEqual(
      s.task({ key: 'work' }).steering!.map(message => message.order),
      [
        1,
        2,
      ],
    )
    assert.equal(
      s.task({ key: 'work' }).steering![0]!.text,
      text,
    )
    assert.equal(
      s.task({ key: 'work' }).steering![0]!.reply,
      'reply-1',
    )
    assert.equal(
      s.task({ key: 'work' }).steering![0]!.source,
      'owner',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'inbox',
          'enqueue',
          'work',
          'unsupported-event',
          '--text',
          'Unstored',
          '--event-id',
          'ignored-before-review',
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'inbox',
          'enqueue',
          'work',
          'unsupported-revision',
          '--text',
          'Unstored',
          '--if-revision',
          '0',
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.deepEqual(
      pending({ card: s.task({ key: 'work' }) }),
      [
        'first',
        'second',
      ],
    )
    const claim = claimFlags({ card: s.task({ key: 'work' }) })
    const read = await worker.run({
      args: [
        'task',
        'inbox',
        'read',
        'work',
      ],
    })
    assert.match(
      read,
      /Olá 🌊/,
    )
    assert.match(
      read,
      /pending: 2/,
    )
    assert.match(
      read,
      new RegExp(s.task({ key: 'work' }).sessionIds![0]!),
    )
    const notification = [
      'task',
      'inbox',
      'notify',
      'work',
      'first',
      ...claim,
      '--attempt',
      'doorbell-1',
      '--result',
      'delivered',
    ]
    await s.owner({ args: notification })
    await s.owner({ args: notification })
    assert.equal(
      s.task({ key: 'work' }).steering![0]!.attempts.length,
      1,
    )
    assert.deepEqual(
      pending({ card: s.task({ key: 'work' }) }),
      [
        'first',
        'second',
      ],
    )
    await pnyx.restart()
    assert.deepEqual(
      pending({ card: s.task({ key: 'work' }) }),
      [
        'first',
        'second',
      ],
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          'second',
          ...claim,
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          'first',
          ...claim,
        ],
      }),
      'NOT_ALLOWED',
    )
    const ack = [
      'task',
      'inbox',
      'ack',
      'work',
      'first',
      ...claim,
    ]
    await worker.run({ args: ack })
    const handledEvents = s.events().filter(event => event.type === 'task.steering.handled').length
    await worker.run({ args: ack })
    assert.equal(
      s.events().filter(event => event.type === 'task.steering.handled').length,
      handledEvents,
    )
    assert.deepEqual(
      pending({ card: s.task({ key: 'work' }) }),
      ['second'],
    )
    assert.equal(
      s.task({ key: 'work' }).steering![0]!.ack!.actor,
      `worker:${s.task({ key: 'work' }).id}`,
    )
    await s.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'work',
        'third',
        '--text',
        'After acknowledgement',
      ],
    })
    assert.deepEqual(
      s.task({ key: 'work' }).steering!.map(message => message.order),
      [
        1,
        2,
        3,
      ],
    )
    rmSync(
      join(
        hydraDir({ hydraId: s.hydraId }),
        'snapshot.json',
      ),
      { force: true },
    )
    await pnyx.restart()
    const restored = s.task({ key: 'work' })
    assert.deepEqual(
      pending({ card: restored }),
      [
        'second',
        'third',
      ],
    )
    const replayed = replay({
      state: emptyHydra(),
      events: s.events(),
    })
    assert.deepEqual(
      replayed.cards[restored.id]!.steering,
      restored.steering,
    )
    assert.equal(
      replayed.cards[restored.id]!.steering![0]!.source,
      'owner',
    )
    const unread = await worker.run({
      args: [
        'task',
        'inbox',
        'read',
        'work',
      ],
    })
    assert.doesNotMatch(
      unread,
      /reply-1/,
    )
    assert.match(
      await worker.run({
        args: [
          'task',
          'inbox',
          'read',
          'work',
          '--all',
        ],
      }),
      /reply-1/,
    )
  },
)

test(
  'stale assignments cannot handle retained messages and concurrent writers keep unique numeric order',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'worker' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Work',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'other',
        '--title',
        'Other',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'work',
      ],
    })
    const worker = s.as({ agent: await s.agent({ cwd: folder }) })
    await until({
      what: 'the worker to become idle',
      check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
    })
    const original = s.task({ key: 'work' })
    const oldClaim = claimFlags({ card: original })
    await Promise.all([
      s.owner({
        args: [
          'task',
          'inbox',
          'enqueue',
          'work',
          'a',
          '--text',
          'A',
        ],
      }),
      s.owner({
        args: [
          'task',
          'inbox',
          'enqueue',
          'work',
          'b',
          '--text',
          'B',
        ],
      }),
    ])
    const messages = s.task({ key: 'work' }).steering!
    assert.deepEqual(
      messages.map(message => message.order),
      [
        1,
        2,
      ],
    )
    assert.deepEqual(
      messages.map(message => message.id).sort(),
      [
        'a',
        'b',
      ],
    )
    assert.deepEqual(
      messages[0]!.queuedFor,
      {
        session: original.sessionIds![0],
        generation: original.steeringGeneration ?? original.createdSeq,
      },
    )
    const first = messages[0]!.id
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'inbox',
          'ack',
          'other',
          first,
          ...oldClaim,
        ],
      }),
      'NOT_ALLOWED',
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          first,
          '--session',
          'claude:wrong',
          '--generation',
          oldClaim[3]!,
        ],
      }),
      'STALE_CLAIM',
    )
    await s.owner({
      args: [
        'task',
        'detach',
        'work',
      ],
    })
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          first,
          ...oldClaim,
        ],
      }),
      'STALE_CLAIM',
    )
    await s.owner({
      args: [
        'task',
        'attach',
        'work',
        '--session',
        original.sessionIds![0]!,
      ],
    })
    const renewed = s.task({ key: 'work' })
    assert.equal(
      renewed.sessionIds![0],
      original.sessionIds![0],
    )
    assert.notEqual(
      renewed.steeringGeneration,
      original.steeringGeneration,
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          first,
          ...oldClaim,
        ],
      }),
      'STALE_CLAIM',
    )
    const renewedClaim = claimFlags({ card: renewed })
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          first,
          ...renewedClaim,
          '--outcome',
          'blocked',
        ],
      }),
      'VALIDATION_ERROR',
    )
    await worker.run({
      args: [
        'task',
        'inbox',
        'ack',
        'work',
        first,
        ...renewedClaim,
        '--outcome',
        'blocked',
        '--note',
        'Needs the owner’s decision, filed separately',
      ],
    })
    assert.equal(
      s.task({ key: 'work' }).steering![0]!.ack!.outcome,
      'blocked',
    )
    assert.deepEqual(
      pending({ card: s.task({ key: 'work' }) }),
      [messages[1]!.id],
    )
    await s.owner({
      args: [
        'task',
        'detach',
        'work',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'work',
        '--folder',
        folder,
      ],
    })
    const replaced = s.task({ key: 'work' })
    assert.notEqual(
      replaced.sessionIds![0],
      renewed.sessionIds![0],
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          messages[1]!.id,
          ...renewedClaim,
        ],
      }),
      'STALE_CLAIM',
    )
    assert.deepEqual(
      pending({ card: replaced }),
      [messages[1]!.id],
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'inbox',
          'read',
          'work',
        ],
      }),
      'STALE_CLAIM',
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          messages[1]!.id,
          ...claimFlags({ card: replaced }),
        ],
      }),
      'STALE_CLAIM',
    )
    const replacement = s.as({ agent: await s.agent({ cwd: folder }) })
    await replacement.run({
      args: [
        'task',
        'inbox',
        'ack',
        'work',
        messages[1]!.id,
        ...claimFlags({ card: replaced }),
      ],
    })
    assert.deepEqual(
      pending({ card: s.task({ key: 'work' }) }),
      [],
    )
  },
)
