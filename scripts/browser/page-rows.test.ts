import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localToken } from '#app/server-state.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { queries } from '#store/zero-schema.ts'
import { scenarioGroup } from '#test-harness/harness.ts'
import { readRows, zeroReady } from '#test-harness/zero-page.ts'

// No browser: the flow reads the rows a page gets, through the same /zero socket and cookie a page uses.
const pnyx = scenarioGroup({ zeroCache: true })

const SECRET = 'SECRET-STEERING'

test(
  'the page\'s Zero rows carry a hidden task\'s state for its chips and leads, never a card\'s private steering, and a page of history at a time',
  async () => {
    const s = await pnyx.scenario()
    const origin = `http://127.0.0.1:${pnyx.port()}`
    const cookie = `${zeroCookieName({ port: pnyx.port() })}=${localToken()}`
    const read = <Rows>({ query }: { query: Parameters<typeof readRows>[0]['query'] }) => readRows<Rows>({
      url: `${origin}/zero`,
      cookie,
      query,
    })

    for (const key of [
      'shown',
      'parked',
    ]) {
      await s.owner({
        args: [
          'task',
          'create',
          '--title',
          key,
          '--key',
          key,
        ],
      })
    }

    await s.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'shown',
        'private-1',
        '--text',
        SECRET,
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'parked',
        'blocked',
        '--note',
        'Waiting on the owner',
      ],
    })
    await s.owner({
      args: [
        'task',
        'hide',
        'parked',
      ],
    })
    const parked = s.task({ key: 'parked' })

    await zeroReady({
      url: `${origin}/zero/`,
      cookie,
    })
    const { hydraId } = s
    const board = await read<{ key: string }[]>({
      query: ({ zero }) => zero.materialize(queries.board.cards({ hydraId })),
    })
    assert.deepEqual(
      board.rows.map(card => card.key),
      ['shown'],
    )
    assert.equal(
      board.frames.some(frame => frame.includes(SECRET)),
      false,
    )

    const references = await read<{
      id: string
      reference: { status?: { state: string } }
    }[]>({ query: ({ zero }) => zero.materialize(queries.cards.references({ hydraId })) })
    assert.equal(
      references.rows.find(row => row.id === parked.id)?.reference.status?.state,
      'blocked',
    )
    assert.equal(
      references.frames.some(frame => frame.includes(SECRET)),
      false,
    )

    const history = await read<unknown[]>({
      query: ({ zero }) => zero.materialize(queries.card.history({
        hydraId,
        cardId: parked.id,
        limit: 1,
      })),
    })
    assert.equal(
      history.rows.length,
      1,
    )
  },
)
