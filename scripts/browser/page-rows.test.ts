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
const QUESTION = 'Ship it on Friday?'

test(
  'the page\'s Zero rows carry a hidden task\'s status and questions for its chips and answer leads, never a card\'s private steering',
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
    // Only Hydra asks the owner.
    const hydra = await s.chat({ text: 'Park the second task until I answer.' })
    await s.as({ agent: hydra }).run({
      args: [
        'task',
        'ask',
        'parked',
        '--to',
        'owner',
        '--question',
        QUESTION,
        '--reason',
        'The owner decides the date.',
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
      JSON.stringify(board.rows).includes(SECRET),
      false,
    )
    assert.equal(
      board.frames.some(frame => frame.includes(SECRET)),
      false,
    )

    const references = await read<{
      id: string
      reference?: {
        data: {
          status?: { state: string }
          asks?: { question: string }[]
        }
      }
    }[]>({ query: ({ zero }) => zero.materialize(queries.cards.references({ hydraId })) })
    const hidden = references.rows.find(row => row.id === parked.id)?.reference?.data
    assert.equal(
      hidden?.status?.state,
      'blocked',
    )
    assert.deepEqual(
      hidden?.asks?.map(ask => ask.question),
      [QUESTION],
    )
    assert.equal(
      JSON.stringify(references.rows).includes(SECRET),
      false,
    )
    assert.equal(
      references.frames.some(frame => frame.includes(SECRET)),
      false,
    )
  },
)
